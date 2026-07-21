import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyOpenRouterSessionId, callProvider, callResearchProvider, checkProviderHealth, createConsecutiveToolCallLoopDetector, createUsageAccumulator, isExplicitDelphiAuditRequest, localResearchToolLoopInstructions, localResearchTurnValidationFeedback, researchHistoryThread, extractModelCapabilitiesFromModels, extractContextWindowFromModels, extractModelIdsFromModels, inferModelCapabilityProfile, researchResponseStyleDirective, researchSystemInstructions, type ResearchProviderContinuation, resolveProviderApiKey, resolvePhaseModelPolicy } from "../src/main/providers";
import { buildAnthropicCompatibleBody, buildAnthropicResearchBody } from "../src/main/providers/anthropic";
import { activeLocalProviderProcesses, buildAntigravityLocalArgs, buildClaudeLocalArgs, buildClaudeLocalResearchArgs, buildCodexLocalArgs, buildCodexLocalResearchArgs, buildGrokLocalArgs, buildKimiLocalArgs, buildOpenCodeLocalArgs, grokCatalogLooksUnauthenticated, grokJsonEvent, kimiArchiCodePermissionConfig, kimiJsonEvent, openCodeJsonEvent, openCodeProcessEnv, parseAntigravityModels, parseGrokModels, parseKimiModels, parseOpenCodeModels, runLocalProcess, windowsBatchCommandLine, windowsExecutableCandidates } from "../src/main/providers/localCli";
import { buildOpenAICompatibleBody, buildOpenAIResearchChatCompletionsBody, buildOpenAIResponsesBody, buildOpenAIResearchResponsesBody } from "../src/main/providers/openai";
import { createSeedProject } from "../src/shared/fixtures";
import { defaultPhaseModelPolicies, defaultSubagentModelPolicies } from "../src/shared/schema";
import type { ResearchChatMessage } from "../src/shared/schema";
import { researchPersonalityPrompt } from "../src/shared/researchPersonality";

function streamingChatCompletionResponse(text: string): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

describe("provider health checks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("advertises Mermaid rendering to the research agent", () => {
    const options = {} as Parameters<typeof researchSystemInstructions>[0];
    expect(researchSystemInstructions(options)).toContain("fenced ```mermaid block");
  });

  it("advertises clickable image previews to the research agent", () => {
    const options = {} as Parameters<typeof researchSystemInstructions>[0];
    expect(researchSystemInstructions(options)).toContain("clickable thumbnails");
    expect(researchSystemInstructions(options)).toContain("archicode://project-file/{projectRelativePath}");
  });

  it("reports offline/manual provider as ready", async () => {
    const provider = {
      id: "offline-manual",
      kind: "offline-manual" as const,
      label: "Legacy Manual",
      localSandbox: "read-only" as const,
      ephemeral: true,
      detectedAvailableModels: [],
      detectedModelCapabilities: {},
      phaseModelPolicies: defaultPhaseModelPolicies,
      subagentModelPolicies: defaultSubagentModelPolicies,
      enabled: true
    };
    const result = await checkProviderHealth(provider);

    expect(result.ok).toBe(true);
    expect(result.status).toBe("ready");
  });

  it("sends the OpenRouter sticky-routing session id only to OpenRouter", () => {
    const openRouterProvider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      baseUrl: "https://openrouter.ai/api/v1"
    };
    const otherProvider = { ...openRouterProvider, baseUrl: "https://api.openai.com/v1" };

    const routedBody: Record<string, unknown> = {};
    applyOpenRouterSessionId(routedBody, openRouterProvider, "run-abc123");
    expect(routedBody.session_id).toBe("run-abc123");

    const longId = "x".repeat(300);
    const truncatedBody: Record<string, unknown> = {};
    applyOpenRouterSessionId(truncatedBody, openRouterProvider, longId);
    expect((truncatedBody.session_id as string).length).toBe(256);

    const foreignBody: Record<string, unknown> = {};
    applyOpenRouterSessionId(foreignBody, otherProvider, "run-abc123");
    expect(foreignBody.session_id).toBeUndefined();

    const emptyIdBody: Record<string, unknown> = {};
    applyOpenRouterSessionId(emptyIdBody, openRouterProvider, "  ");
    expect(emptyIdBody.session_id).toBeUndefined();
  });

  it("warns the model one identical tool call before aborting the loop", () => {
    const detector = createConsecutiveToolCallLoopDetector();
    expect(detector.record("submit_source_file", "{\"path\":\"a\"}")).toBeUndefined();
    const warning = detector.record("submit_source_file", "{\"path\":\"a\"}");
    expect(warning).toContain("loop guard");
    expect(warning).toContain("submit_source_file");
    expect(() => detector.record("submit_source_file", "{\"path\":\"a\"}")).toThrow(/Consecutive identical tool-call loop/);

    const reset = createConsecutiveToolCallLoopDetector();
    reset.record("submit_source_file", "{\"path\":\"a\"}");
    reset.record("submit_source_file", "{\"path\":\"a\"}");
    // Changing the arguments resets the streak instead of aborting.
    expect(reset.record("submit_source_file", "{\"path\":\"b\"}")).toBeUndefined();
  });

  it("recognizes malformed local research tool envelopes as private transport output", () => {
    const malformed = '```json\n{"archicodeResearchTurn":{"toolCalls":[{"id":"read-1","providerToolName":"archicode_project_read_file","arguments":{"path":"README.md}}]}}}\n```';
    const valid = JSON.stringify({
      archicodeResearchTurn: {
        toolCalls: [{
          id: "read-1",
          providerToolName: "archicode_project_read_file",
          arguments: { path: "README.md" }
        }]
      }
    });

    expect(localResearchTurnValidationFeedback(malformed)).toContain("could not parse it as a valid tool turn");
    expect(localResearchTurnValidationFeedback(valid)).toBeUndefined();
    expect(localResearchTurnValidationFeedback("The project review is complete.")).toBeUndefined();
  });

  it("routes only explicit executable test and runtime-audit requests to Delphi", () => {
    expect(isExplicitDelphiAuditRequest("Run and test the current website, then report what you find.")).toBe(true);
    expect(isExplicitDelphiAuditRequest("Please retest the mobile app in the emulator.")).toBe(true);
    expect(isExplicitDelphiAuditRequest("Perform a visual audit of this site.")).toBe(true);
    expect(isExplicitDelphiAuditRequest("Explain why the existing test failed.")).toBe(false);
    expect(isExplicitDelphiAuditRequest("Check the project settings for me.")).toBe(false);
  });

  it("records whether replayable reasoning state was received across provider rounds", () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!;
    const received = createUsageAccumulator();
    received.add({ inputTokens: 10, outputTokens: 5, reasoningReplayState: "received" });
    expect(received.finalize(provider, "test-model").reasoningReplayState).toBe("received");

    const mixed = createUsageAccumulator();
    mixed.add({ reasoningReplayState: "received" });
    mixed.add({ reasoningReplayState: "absent" });
    expect(mixed.finalize(provider, "test-model").reasoningReplayState).toBe("mixed");
  });

  it("evicts research history in batches so the window start stays stable between turns", () => {
    const makeMessage = (index: number): ResearchChatMessage => ({
      id: `m${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `m${index}`.padEnd(40, "x"),
      createdAt: new Date().toISOString(),
      attachmentIds: [],
      webUsed: false,
      mcpToolCalls: [],
      subagentRuns: []
    });
    // Each message estimates to 18 tokens (40 chars / 4 + 8 overhead); with a
    // 60-token budget the window overflows on the 4th message and must evict
    // down to 45 tokens (75%) in one batch.
    const thread = (count: number) => researchHistoryThread("__current__", {
      scopeContext: "",
      messages: Array.from({ length: count }, (_, index) => makeMessage(index)),
      researchMessageLimit: 64,
      researchHistoryTokenBudget: 60
    });

    expect(thread(4)[0]?.text.startsWith("m2")).toBe(true);
    // Appending one more message must NOT slide the window start.
    expect(thread(5)[0]?.text.startsWith("m2")).toBe(true);
    // The next overflow evicts a batch of two, not one.
    expect(thread(6)[0]?.text.startsWith("m4")).toBe(true);
  });

  it("marks the stable block of single-shot Anthropic prompts as a cache breakpoint", () => {
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      kind: "anthropic-compatible" as const,
      model: "claude-sonnet-4-6"
    };
    const body = buildAnthropicCompatibleBody(provider, "{\"project\":true}", "Code a feature", false, "coding", defaultPhaseModelPolicies.coding);
    const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content;
    expect(content[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(String(content[0]!.text)).toContain("Project JSON context:");
    expect(content[1]!.cache_control).toBeUndefined();
    expect(String(content[1]!.text)).toContain("Prompt summary: Code a feature");
  });

  it("adds explicit cache_control blocks only for OpenRouter chat-completions bodies", () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!;
    const openRouterProvider = { ...provider, baseUrl: "https://openrouter.ai/api/v1" };

    const routedBody = buildOpenAICompatibleBody(openRouterProvider, "{\"project\":true}", "Code a feature", false, "coding", defaultPhaseModelPolicies.coding);
    const routedMessages = routedBody.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(routedMessages[0]!.content[0]!.cache_control).toEqual({ type: "ephemeral" });
    const userBlocks = routedMessages[1]!.content;
    expect(userBlocks[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(String(userBlocks[0]!.text)).toContain("Project JSON context:");
    expect(userBlocks[1]!.cache_control).toBeUndefined();

    const plainBody = buildOpenAICompatibleBody({ ...provider, baseUrl: "https://api.openai.com/v1" }, "{\"project\":true}", "Code a feature", false, "coding", defaultPhaseModelPolicies.coding);
    const plainMessages = plainBody.messages as Array<{ content: unknown }>;
    expect(typeof plainMessages[0]!.content).toBe("string");
    expect(typeof plainMessages[1]!.content).toBe("string");
    expect(JSON.stringify(plainBody)).not.toContain("cache_control");
  });

  it("reports missing API key before network calls", async () => {
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKeyEnv: "ARCHICODE_TEST_MISSING_KEY"
    };
    const result = await checkProviderHealth(provider);

    expect(result.ok).toBe(false);
    expect(result.status).toBe("missing-key");
    expect(result.message).toContain("Missing API key");
    expect(result.message).not.toContain("ARCHICODE_TEST_MISSING_KEY");
  });

  it("uses the OpenAI minimum output token limit for Responses health probes", async () => {
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "gpt-5.4", context_window: 272000 }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (target.endsWith("/responses")) {
        return new Response(JSON.stringify({ status: "completed", output_text: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKey: "sk-test",
      model: "gpt-5.4"
    };

    const result = await checkProviderHealth(provider);
    const responsesCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/responses"));
    const body = JSON.parse(String((responsesCall?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(body.max_output_tokens).toBe(16);
  });

  it("uses a pasted provider API key directly", () => {
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKey: "sk-test-direct-key"
    };

    expect(resolveProviderApiKey(provider)).toBe("sk-test-direct-key");
  });

  it("treats legacy raw-key env field values as direct keys", () => {
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKeyEnv: "sk-test-legacy-key"
    };

    expect(resolveProviderApiKey(provider)).toBe("sk-test-legacy-key");
  });

  it("reports unavailable Codex local command", async () => {
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "codex-local")!,
      localCommand: "archicode-missing-codex-command"
    };
    const result = await checkProviderHealth(provider);

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
  });

  it("reports unavailable Claude local command", async () => {
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "claude-local")!,
      localCommand: "archicode-missing-claude-command"
    };
    const result = await checkProviderHealth(provider);

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
  });

  it("reports unavailable OpenCode local command", async () => {
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "opencode-local")!,
      localCommand: "archicode-missing-opencode-command"
    };
    const result = await checkProviderHealth(provider);

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
  });

  it("reports unavailable Antigravity local command", async () => {
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "codex-local")!,
      id: "antigravity-local",
      kind: "antigravity-local" as const,
      label: "Google Antigravity CLI",
      localCommand: "archicode-missing-agy-command"
    };
    const result = await checkProviderHealth(provider);

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
  });

  it("reports unavailable Grok Build local command", async () => {
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "codex-local")!,
      id: "grok-local",
      kind: "grok-local" as const,
      label: "Grok Build CLI",
      localCommand: "archicode-missing-grok-command"
    };
    const result = await checkProviderHealth(provider);

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
  });

  it("reports unavailable Kimi Code local command", async () => {
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "codex-local")!,
      id: "kimi-local",
      kind: "kimi-local" as const,
      label: "Kimi Code CLI",
      localCommand: "archicode-missing-kimi-command"
    };
    const result = await checkProviderHealth(provider);

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
  });

  it("keeps OpenCode provider/model IDs intact and parses JSON text events", () => {
    expect(parseOpenCodeModels("opencode-go/kimi-k2.5\nanthropic/claude-sonnet-4-5\nnoise\n")).toEqual([
      "anthropic/claude-sonnet-4-5",
      "opencode-go/kimi-k2.5"
    ]);
    expect(openCodeJsonEvent(JSON.stringify({
      type: "text",
      sessionID: "ses_test",
      part: { text: "hello" }
    }))).toEqual({
      sessionId: "ses_test",
      text: { tokenKind: "answer", value: "hello" }
    });
  });

  it("keeps Antigravity model display names intact and builds safe one-shot modes", () => {
    expect(parseAntigravityModels("Gemini 3.5 Flash (High)\nClaude Sonnet 4.6 (Thinking)\n")).toEqual([
      "Claude Sonnet 4.6 (Thinking)",
      "Gemini 3.5 Flash (High)"
    ]);
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "codex-local")!,
      id: "antigravity-local",
      kind: "antigravity-local" as const,
      label: "Google Antigravity CLI",
      localCommand: "agy",
      model: "Gemini 3.5 Flash (High)",
      localProfile: "reviewer"
    };
    expect(buildAntigravityLocalArgs({ ...provider, localSandbox: "read-only" }, "planning", "Plan it")).toEqual([
      "--print", "Plan it", "--print-timeout", "5m", "--mode", "plan", "--model", "Gemini 3.5 Flash (High)", "--agent", "reviewer", "--sandbox", "--dangerously-skip-permissions"
    ]);
    expect(buildAntigravityLocalArgs({ ...provider, localSandbox: "workspace-write" }, "coding", "Build it")).toEqual([
      "--print", "Build it", "--print-timeout", "5m", "--mode", "accept-edits", "--model", "Gemini 3.5 Flash (High)", "--agent", "reviewer", "--sandbox", "--dangerously-skip-permissions"
    ]);
    expect(buildAntigravityLocalArgs({ ...provider, localSandbox: "danger-full-access" }, "coding", "Build it")).not.toContain("--sandbox");
  });

  it("parses Grok Build models and streaming events and maps phase access", () => {
    expect(parseGrokModels("Available models:\n● grok-build-0.1 Grok Build\ncomposer-2.5 Composer\n")).toEqual([
      "composer-2.5",
      "grok-build-0.1"
    ]);
    expect(grokJsonEvent(JSON.stringify({
      type: "message",
      session_id: "grok-session",
      role: "assistant",
      content: [{ type: "text", text: "hello" }]
    }))).toEqual({
      sessionId: "grok-session",
      text: { kind: "delta", tokenKind: "answer", value: "hello" }
    });
    expect(grokCatalogLooksUnauthenticated("You are not authenticated.\nAvailable models:\n* grok-build")).toBe(true);
    expect(grokCatalogLooksUnauthenticated("Available models:\n* grok-build")).toBe(false);
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "codex-local")!,
      id: "grok-local",
      kind: "grok-local" as const,
      label: "Grok Build CLI",
      localCommand: "grok",
      model: "grok-build-0.1",
      localProfile: "reviewer"
    };
    expect(buildGrokLocalArgs({ ...provider, localSandbox: "read-only" }, "planning", "Plan it", false)).toEqual([
      "--output-format", "streaming-json", "--no-memory", "--no-subagents",
      "--permission-mode", "dontAsk", "--sandbox", "read-only",
      "--model", "grok-build-0.1", "--reasoning-effort", "high", "--agent", "reviewer",
      "--disable-web-search", "-p", "Plan it"
    ]);
    const writeArgs = buildGrokLocalArgs({ ...provider, localSandbox: "workspace-write" }, "coding", "Build it", true);
    expect(writeArgs).toContain("bypassPermissions");
    expect(writeArgs).toContain("workspace");
    expect(writeArgs).not.toContain("--disable-web-search");
    expect(buildGrokLocalArgs({ ...provider, localSandbox: "danger-full-access" }, "coding", "Build it", true)).toContain("off");
  });

  it("parses Kimi configured models and assistant JSONL and builds one-shot args", () => {
    expect(parseKimiModels(JSON.stringify({
      providers: { kimi: { type: "kimi" } },
      models: {
        "kimi-code/kimi-for-coding": { provider: "kimi" },
        "openai/gpt-test": { provider: "openai" }
      }
    }))).toEqual(["kimi-code/kimi-for-coding", "openai/gpt-test"]);
    expect(kimiJsonEvent(JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "Kimi answer" }]
    }))).toEqual({
      text: { kind: "full", tokenKind: "answer", value: "Kimi answer" }
    });
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "codex-local")!,
      id: "kimi-local",
      kind: "kimi-local" as const,
      label: "Kimi Code CLI",
      localCommand: "kimi",
      model: "kimi-code/kimi-for-coding"
    };
    expect(buildKimiLocalArgs(provider, "planning", "Plan it")).toEqual([
      "--prompt", "Plan it", "--output-format", "stream-json", "--model", "kimi-code/kimi-for-coding"
    ]);
    const readOnlyRules = kimiArchiCodePermissionConfig({ ...provider, localSandbox: "read-only" }, "planning", "/tmp/archicode");
    expect(readOnlyRules).toContain('pattern = "Write"');
    expect(readOnlyRules).toContain('pattern = "Bash"');
    expect(readOnlyRules).not.toContain("ArchiCode workspace write");
    const workspaceRules = kimiArchiCodePermissionConfig({ ...provider, localSandbox: "workspace-write" }, "coding", "/tmp/archicode");
    expect(workspaceRules.indexOf('pattern = "Write(/tmp/archicode/**)"')).toBeLessThan(workspaceRules.indexOf('pattern = "Write"'));
    expect(workspaceRules).toContain('pattern = "mcp__*"');
    expect(kimiArchiCodePermissionConfig({ ...provider, localSandbox: "danger-full-access" }, "coding", "/tmp/archicode")).toBe("");
  });

  it("discovers Kimi models and runs a fresh one-shot response", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-kimi-path-"));
    const binDir = path.join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const commandPath = path.join(binDir, "mock-kimi");
    await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.join(" ") === "--version") process.stdout.write("kimi 1.0.0\\n");
else if (args.join(" ") === "provider list --json") process.stdout.write(JSON.stringify({ providers: { kimi: {} }, models: { "kimi-code/kimi-for-coding": {} } }) + "\\n");
else if (args.includes("--prompt") && args.includes("--output-format")) {
  const prompt = args[args.indexOf("--prompt") + 1] || "";
  const kimiHome = process.env.KIMI_CODE_HOME || "";
  fs.writeFileSync(path.join(process.cwd(), "kimi-home.txt"), kimiHome);
  const isolatedConfig = fs.readFileSync(path.join(kimiHome, "config.toml"), "utf8");
  if (!prompt.includes("Kimi test") || !isolatedConfig.includes('pattern = "Write"')) process.exitCode = 2;
  else process.stdout.write(JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Kimi answer" }] }) + "\\n");
} else process.exitCode = 1;
`, "utf8");
    await chmod(commandPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "codex-local")!,
      id: "kimi-local",
      kind: "kimi-local" as const,
      label: "Kimi Code CLI",
      localCommand: "mock-kimi",
      model: "kimi-code/kimi-for-coding",
      localSandbox: "read-only" as const
    };
    try {
      const health = await checkProviderHealth(provider);
      expect(health.ok).toBe(true);
      expect(health.availableModels).toEqual(["kimi-code/kimi-for-coding"]);
      expect(health.modelListSource).toBe("kimi provider list --json");
      await expect(callProvider(provider, "{}", "Kimi test", {
        projectRoot: root,
        phase: "planning"
      })).resolves.toBe("Kimi answer");
      const isolatedHome = await readFile(path.join(root, "kimi-home.txt"), "utf8");
      await expect(readFile(path.join(isolatedHome, "config.toml"), "utf8")).rejects.toThrow();
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("discovers Grok Build models, parses a one-shot response, and deletes its session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-grok-path-"));
    const binDir = path.join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const commandPath = path.join(binDir, "mock-grok");
    const cleanupMarker = path.join(root, "session-deleted.txt");
    await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.join(" ") === "--version") process.stdout.write("grok 0.2.103\\n");
else if (args.join(" ") === "models") process.stdout.write("Available models:\\n● grok-build-0.1 Grok Build\\ncomposer-2.5 Composer\\n");
else if (args[0] === "sessions" && args[1] === "delete") fs.writeFileSync(${JSON.stringify(cleanupMarker)}, args[2] || "");
else if (args.includes("-p")) {
  const prompt = args[args.indexOf("-p") + 1] || "";
  if (!prompt.includes("Grok test")) process.exitCode = 2;
  else {
    process.stdout.write(JSON.stringify({ type: "init", session_id: "grok-session" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "message", role: "assistant", content: "Grok answer" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", result: "Grok answer" }) + "\\n");
  }
} else process.exitCode = 1;
`, "utf8");
    await chmod(commandPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "codex-local")!,
      id: "grok-local",
      kind: "grok-local" as const,
      label: "Grok Build CLI",
      localCommand: "mock-grok",
      model: "grok-build-0.1",
      localSandbox: "read-only" as const,
      ephemeral: true
    };
    try {
      const health = await checkProviderHealth(provider);
      expect(health.ok).toBe(true);
      expect(health.availableModels).toEqual(["composer-2.5", "grok-build-0.1"]);
      expect(health.modelListSource).toBe("grok models");
      await expect(callProvider(provider, "{}", "Grok test", { projectRoot: root, phase: "planning" })).resolves.toBe("Grok answer");
      expect(await readFile(cleanupMarker, "utf8")).toBe("grok-session");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("discovers Antigravity models and runs a plain-text one-shot call", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-agy-path-"));
    const binDir = path.join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const commandPath = path.join(binDir, "mock-agy");
    await writeFile(commandPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.join(" ") === "--version") process.stdout.write("1.1.4\\n");
else if (args.join(" ") === "models") process.stdout.write("Gemini 3.5 Flash (High)\\nClaude Sonnet 4.6 (Thinking)\\n");
else if (args.includes("--print")) {
  const prompt = args[args.indexOf("--print") + 1] || "";
  if (!prompt.includes("Antigravity test")) process.exitCode = 2;
  else process.stdout.write("Antigravity answer\\n");
} else process.exitCode = 1;
`, "utf8");
    await chmod(commandPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "codex-local")!,
      id: "antigravity-local",
      kind: "antigravity-local" as const,
      label: "Google Antigravity CLI",
      localCommand: "mock-agy",
      model: "Gemini 3.5 Flash (High)",
      localSandbox: "read-only" as const
    };
    try {
      const health = await checkProviderHealth(provider);
      expect(health.ok).toBe(true);
      expect(health.availableModels).toEqual(["Claude Sonnet 4.6 (Thinking)", "Gemini 3.5 Flash (High)"]);
      expect(health.modelListSource).toBe("agy models");
      await expect(callProvider(provider, "{}", "Antigravity test", {
        projectRoot: root,
        phase: "planning"
      })).resolves.toBe("Antigravity answer");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("builds one-shot OpenCode args with a composite phase model", () => {
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "opencode-local")!,
      model: "opencode-go/kimi-k2.5",
      localProfile: "build",
      localSandbox: "workspace-write" as const
    };
    expect(buildOpenCodeLocalArgs(provider, { phase: "coding", projectRoot: "/tmp/archicode" })).toEqual([
      "run", "--format", "json", "--dir", "/tmp/archicode", "--model", "opencode-go/kimi-k2.5", "--agent", "build", "--auto"
    ]);
    const workspaceConfig = JSON.parse(openCodeProcessEnv(provider, "coding")!.OPENCODE_CONFIG_CONTENT!);
    expect(workspaceConfig.permission).toEqual({ external_directory: "deny" });
    expect(openCodeProcessEnv({ ...provider, localSandbox: "danger-full-access" }, "coding")).toBeUndefined();
    const readOnlyConfig = JSON.parse(openCodeProcessEnv({ ...provider, localSandbox: "read-only" }, "coding")!.OPENCODE_CONFIG_CONTENT!);
    expect(readOnlyConfig.permission).toMatchObject({ edit: "deny", bash: "deny", external_directory: "deny" });
    expect(readOnlyConfig.agent.build.permission.edit).toBe("deny");
  });

  it("discovers OpenCode models through a bare PATH command", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-opencode-path-"));
    const binDir = path.join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const commandPath = path.join(binDir, "mock-opencode");
    await writeFile(commandPath, `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args === "--version") process.stdout.write("opencode 1.2.3\\n");
else if (args === "models") process.stdout.write("opencode-go/kimi-k2.5\\nanthropic/claude-sonnet-4-5\\n");
else process.exitCode = 1;
`, "utf8");
    await chmod(commandPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "opencode-local")!,
      localCommand: "mock-opencode"
    };
    try {
      const result = await checkProviderHealth(provider);
      expect(result.ok).toBe(true);
      expect(result.availableModels).toEqual(["anthropic/claude-sonnet-4-5", "opencode-go/kimi-k2.5"]);
      expect(result.modelListSource).toBe("opencode models");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("runs OpenCode as a one-shot provider and deletes its ephemeral session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-opencode-run-"));
    const commandPath = path.join(root, "mock-opencode.cjs");
    await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "session" && args[1] === "delete") {
  fs.writeFileSync(path.join(process.cwd(), "deleted-session.txt"), args[2]);
  process.exit(0);
}
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (!args.includes("run") || !args.includes("--format") || !prompt.includes("Plan it")) process.exit(2);
  process.stdout.write(JSON.stringify({ type: "step_start", sessionID: "ses_ephemeral", part: {} }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "text", sessionID: "ses_ephemeral", part: { text: "OpenCode answer" } }) + "\\n");
});
`, "utf8");
    await chmod(commandPath, 0o755);
    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "opencode-local")!,
      localCommand: commandPath,
      model: "opencode-go/kimi-k2.5",
      ephemeral: true
    };

    const answer = await callProvider(provider, "{}", "Plan it", { projectRoot: root, phase: "planning" });

    expect(answer).toBe("OpenCode answer");
    expect(await readFile(path.join(root, "deleted-session.txt"), "utf8")).toBe("ses_ephemeral");
  });

  it("finds Codex local command by bare name through PATH", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-codex-path-"));
    const binDir = path.join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const commandPath = path.join(binDir, "mock-codex");
    await writeFile(commandPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.join(" ") === "--version") {
  process.stdout.write("codex 1.0.0\\n");
  process.exit(0);
}
if (args.join(" ") === "login status") {
  process.stdout.write("signed in\\n");
  process.exit(0);
}
if (args.join(" ") === "debug models") {
  process.stdout.write(JSON.stringify({ models: [{ id: "gpt-5.4", context_window: 272000 }] }) + "\\n");
  process.exit(0);
}
process.exit(1);
`, "utf8");
    await chmod(commandPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "codex-local")!,
      localCommand: "mock-codex",
      model: "gpt-5.4"
    };

    try {
      const result = await checkProviderHealth(provider);
      expect(result.ok).toBe(true);
      expect(result.message).toContain("Codex CLI available and authenticated");
      expect(result.availableModels).toContain("gpt-5.4");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("finds Claude local command by bare name through PATH", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-claude-path-"));
    const binDir = path.join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const commandPath = path.join(binDir, "mock-claude");
    await writeFile(commandPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.join(" ") === "--version") {
  process.stdout.write("2.1.71 (Claude Code)\\n");
  process.exit(0);
}
if (args.join(" ") === "auth status") {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "oauth" }) + "\\n");
  process.exit(0);
}
process.exit(1);
`, "utf8");
    await chmod(commandPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "claude-local")!,
      localCommand: "mock-claude"
    };

    try {
      const result = await checkProviderHealth(provider);
      expect(result.ok).toBe(true);
      expect(result.message).toContain("Claude Code CLI available and authenticated");
      expect(result.message).toContain("fallback model suggestions");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("captures fast Codex local exits without surfacing stdin EPIPE as an uncaught exception", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-codex-epipe-"));
    const commandPath = path.join(root, "codex-exits-fast.cjs");
    await writeFile(commandPath, `#!/usr/bin/env node
process.stderr.write("mock codex exited before reading stdin\\n");
process.exit(2);
`, "utf8");
    await chmod(commandPath, 0o755);

    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "codex-local")!,
      localCommand: commandPath
    };

    await expect(callProvider(
      provider,
      "large prompt\n".repeat(1_000_000),
      "Plan a change",
      { projectRoot: root, phase: "planning" }
    )).rejects.toThrow(/mock codex exited before reading stdin|stdin stream error/);
  });

  it("terminates a local provider process group after sustained output inactivity", async () => {
    const initialActiveProcesses = activeLocalProviderProcesses.size;

    await expect(runLocalProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      "",
      undefined,
      undefined,
      undefined,
      { inactivityTimeoutMs: 50 }
    )).rejects.toThrow("Local provider call produced no output for 50ms");

    expect(activeLocalProviderProcesses.size).toBe(initialActiveProcesses);
  });

  it("keeps a long local provider call alive while it continues producing output", async () => {
    const result = await runLocalProcess(
      process.execPath,
      ["-e", "let count = 0; const timer = setInterval(() => { process.stdout.write('.'); count += 1; if (count === 7) { clearInterval(timer); process.exit(0); } }, 100)"],
      "",
      undefined,
      undefined,
      undefined,
      // Leave enough scheduling slack for this timing test when the full suite
      // saturates the worker pool; the child still emits every 100ms.
      { inactivityTimeoutMs: 750 }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(".......");
  });

  it("extracts context windows from OpenAI-compatible model metadata", () => {
    const detected = extractContextWindowFromModels({
      data: [
        { id: "small-model", context_length: 8192 },
        { id: "custom-model", metadata: { max_context_length: "131072" } }
      ]
    }, "custom-model");

    expect(detected).toBe(131072);
  });

  it("extracts context windows from Codex debug model catalogs", () => {
    const detected = extractContextWindowFromModels({
      models: [
        { slug: "gpt-5.5", display_name: "GPT-5.5", context_window: 272000 },
        { slug: "gpt-5.3-codex-spark", display_name: "Spark", context_window: 128000 }
      ]
    }, "gpt-5.5");

    expect(detected).toBe(272000);
  });

  it("uses the known GPT-5.6 family context window when local metadata is stale", () => {
    const detected = extractContextWindowFromModels({
      models: [
        { slug: "gpt-5.6-terra", display_name: "GPT-5.6 Terra", context_window: 272000 },
        { slug: "gpt-5.5", display_name: "GPT-5.5", context_window: 272000 }
      ]
    }, "gpt-5.6-terra");

    expect(detected).toBe(1050000);
  });

  it("uses known current model floors when provider model metadata is stale", () => {
    const detected = extractContextWindowFromModels({
      models: [
        { slug: "grok-4.5", context_window: 64000 },
        { slug: "kimi-k3", context_window: 128000 },
        { slug: "qwen/qwen3.7-plus", context_window: 128000 }
      ]
    }, "kimi-k3");

    expect(detected).toBe(1000000);
  });

  it("does not borrow another model context window when the selected model is missing", () => {
    const detected = extractContextWindowFromModels({
      models: [
        { slug: "gpt-5.5", display_name: "GPT-5.5", context_window: 272000 }
      ]
    }, "custom-missing-model");

    expect(detected).toBeUndefined();
  });

  it("extracts available model IDs from provider model lists", () => {
    const ids = extractModelIdsFromModels({
      data: [
        { id: "gpt-3.5-turbo", created: 1000 },
        { id: "text-embedding-ada-002", created: 1500 },
        { id: "tts-1", created: 1600 },
        { id: "gpt-realtime", created: 1700 },
        { id: "gpt-audio", created: 1800 },
        { id: "gpt-image-1", created: 1900 },
        { id: "sora-2", created: 1950 },
        { id: "gpt-4o", created: 2000 },
        { id: "gpt-5.5", created: 3000 },
        { id: "deepseek-chat", created: 3100 },
        { name: "claude-sonnet-4-6" }
      ]
    });

    expect(ids).toEqual(["deepseek-chat", "gpt-5.5", "gpt-4o", "gpt-3.5-turbo", "claude-sonnet-4-6"]);
  });

  it("uses text-generation metadata instead of model-family names", () => {
    const ids = extractModelIdsFromModels({
      data: [
        { id: "openrouter/free", architecture: { output_modalities: ["text"] } },
        { id: "nvidia/nemotron:free", architecture: { modality: "text->text" } },
        { id: "google/gemma:free", output_modalities: ["text"] },
        { id: "future-lab/unknown-chat-model" },
        { id: "acme/image-generator", output_modalities: ["image"] },
        { id: "acme/multimodal-generator", output_modalities: ["text", "image"] },
        { id: "acme/vector-model", task: "feature_extraction" },
        { id: "acme/text-to-speech-model" }
      ]
    });

    expect(ids).toEqual([
      "future-lab/unknown-chat-model",
      "google/gemma:free",
      "nvidia/nemotron:free",
      "openrouter/free"
    ]);
  });

  it("extracts available model IDs from Codex debug model catalogs", () => {
    const ids = extractModelIdsFromModels({
      models: [
        { slug: "gpt-5.5" },
        { slug: "gpt-5.4-mini" }
      ]
    });

    expect(ids).toEqual(["gpt-5.4-mini", "gpt-5.5"]);
  });

  it("extracts per-model image support from models metadata", () => {
    const capabilities = extractModelCapabilitiesFromModels({
      data: [
        { id: "deepseek-chat", modalities: ["text"] },
        { id: "gpt-4o", modalities: ["text", "image"] },
        { id: "qwen2.5-vl", capabilities: { vision: true } }
      ]
    }, "openai-compatible");

    expect(capabilities["deepseek-chat"]?.supportsImageInput).toBe(false);
    expect(capabilities["gpt-4o"]?.supportsImageInput).toBe(true);
    expect(capabilities["qwen2.5-vl"]?.supportsImageInput).toBe(true);
  });

  it("extracts authoritative per-model context and output limits when catalogs advertise them", () => {
    const anthropic = extractModelCapabilitiesFromModels({
      data: [
        { id: "claude-sonnet-4-6", max_input_tokens: 1_000_000, max_tokens: 64_000 }
      ]
    }, "anthropic-compatible");
    const openRouter = extractModelCapabilitiesFromModels({
      data: [
        {
          id: "qwen/qwen3.7-plus",
          context_length: 131_072,
          top_provider: { max_completion_tokens: 32_768 }
        }
      ]
    }, "openai-compatible");

    expect(anthropic["claude-sonnet-4-6"]).toEqual(expect.objectContaining({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 64_000
    }));
    expect(openRouter["qwen/qwen3.7-plus"]).toEqual(expect.objectContaining({
      contextWindowTokens: 131_072,
      maxOutputTokens: 32_768
    }));
  });

  it("clamps a phase ceiling only when the selected model advertises a lower output maximum", () => {
    const seed = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!;
    const known = {
      ...seed,
      detectedModelCapabilities: {
        [seed.model!]: { maxOutputTokens: 24_000 }
      }
    };

    const policy = resolvePhaseModelPolicy(known, "coding");
    const body = buildOpenAIResponsesBody(known, "{}", "Code a feature", false, "coding", policy);

    expect(policy.maxOutputTokens).toBe(24_000);
    expect(body.max_output_tokens).toBe(24_000);
    expect(resolvePhaseModelPolicy(seed, "coding").maxOutputTokens).toBe(64_000);
  });

  it("lets detected model capabilities override the fallback image heuristic", () => {
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      model: "gpt-4o",
      detectedModelCapabilities: {
        "gpt-4o": { supportsImageInput: false }
      }
    };

    expect(inferModelCapabilityProfile(provider).supportsImageInput).toBe(false);
  });

  it("prefers Windows launchable command shims before bare command names", () => {
    const candidates = windowsExecutableCandidates("codex", "win32", ".COM;.EXE;.BAT;.CMD");

    expect(candidates[0]).toBe("codex.com");
    expect(candidates).toContain("codex.cmd");
    expect(candidates.at(-1)).toBe("codex");
  });

  it("quotes Windows batch command lines for paths with spaces", () => {
    const commandLine = windowsBatchCommandLine("C:\\Program Files\\nodejs\\codex.cmd", ["--version"]);

    expect(commandLine).toBe("call \"C:\\Program Files\\nodejs\\codex.cmd\" \"--version\"");
  });

  it("passes phase temperature and GPT-5 token limit to OpenAI-compatible requests", () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!;
    const policy = resolvePhaseModelPolicy(provider, "coding");
    const body = buildOpenAICompatibleBody(provider, "{}", "Code a feature", false, "coding", policy);

    expect(body.temperature).toBe(policy.temperature);
    expect(body.max_completion_tokens).toBe(policy.maxOutputTokens);
    expect(body.max_tokens).toBeUndefined();
    expect(JSON.stringify(body)).toContain("propose-source-file");
    expect(JSON.stringify(body)).toContain("top-level shape: { \\\"archicodePatch\\\": { ... } }");
    expect(JSON.stringify(body)).toContain("Do not return the bare patch object");
    expect(JSON.stringify(body)).toContain("runSummary.notes and runSummary.verificationNotes must be strings");
    expect(JSON.stringify(body)).toContain("smallest self-contained runnable slice");
  });

  it("ignores a phase model override that disappeared from a checked provider catalog", () => {
    const seed = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!;
    const provider = {
      ...seed,
      detectedAvailableModels: ["gpt-current"],
      phaseModelPolicies: {
        ...seed.phaseModelPolicies,
        planning: { ...seed.phaseModelPolicies.planning, modelOverride: "gpt-removed" },
        coding: { ...seed.phaseModelPolicies.coding, modelOverride: "gpt-current" }
      }
    };

    expect(resolvePhaseModelPolicy(provider, "planning").modelOverride).toBeUndefined();
    expect(resolvePhaseModelPolicy(provider, "coding").modelOverride).toBe("gpt-current");
  });

  it("keeps legacy max_tokens for older OpenAI-compatible chat models", () => {
    const seed = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!;
    const provider = { ...seed, model: "gpt-4.1" };
    const policy = resolvePhaseModelPolicy(provider, "coding");
    const body = buildOpenAICompatibleBody(provider, "{}", "Code a feature", false, "coding", policy);

    expect(body.max_tokens).toBe(policy.maxOutputTokens);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it("uses Responses-native max_output_tokens for OpenAI-compatible Responses bodies", () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!;
    const policy = resolvePhaseModelPolicy(provider, "coding");
    const body = buildOpenAIResponsesBody(provider, "{}", "Code a feature", false, "coding", policy);

    expect(body.max_output_tokens).toBe(policy.maxOutputTokens);
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
    expect(JSON.stringify(body)).toContain("top-level shape: { \\\"archicodePatch\\\": { ... } }");
    expect(JSON.stringify(body)).toContain("\\\"operations\\\": [");
    expect(JSON.stringify(body)).toContain("smallest self-contained runnable slice");
  });

  it("adds configured output verbosity only to GPT-5.6 Responses requests", async () => {
    const seed = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!;
    const provider = { ...seed, model: "openai/gpt-5.6-terra", outputVerbosity: "high" as const };
    const policy = resolvePhaseModelPolicy(provider, "brainstorming");
    const buildBody = buildOpenAIResponsesBody(provider, "{}", "Explain this", false, "brainstorming", policy);
    const researchBody = await buildOpenAIResearchResponsesBody(provider, "Explain this", {
      scopeContext: "{}",
      messages: [],
      webSearchEnabled: false
    }, policy);
    const chatBody = buildOpenAICompatibleBody(provider, "{}", "Explain this", false, "brainstorming", policy);
    const olderModelBody = buildOpenAIResponsesBody(
      { ...provider, model: "gpt-5.5" },
      "{}",
      "Explain this",
      false,
      "brainstorming",
      defaultPhaseModelPolicies.brainstorming
    );

    expect(buildBody.text).toEqual({ verbosity: "high" });
    expect(researchBody.text).toEqual({ verbosity: "high" });
    expect(chatBody.text).toBeUndefined();
    expect(olderModelBody.text).toBeUndefined();
  });

  it("sends the same explicit coding patch contract to Anthropic-compatible providers", () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "anthropic-compatible")!;
    const policy = resolvePhaseModelPolicy(provider, "coding");
    const body = buildAnthropicCompatibleBody(provider, "{}", "Code a feature", false, "coding", policy);
    const prompt = JSON.stringify(body);

    expect(prompt).toContain("top-level shape: { \\\"archicodePatch\\\": { ... } }");
    expect(prompt).toContain("Do not return the bare patch object");
    expect(prompt).toContain("runSummary.notes and runSummary.verificationNotes must be strings");
    expect(prompt).toContain("\\\"kind\\\": \\\"propose-source-file\\\"");
  });

  it("sends an explicit planning patch contract to API providers", () => {
    const openaiProvider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!;
    const anthropicProvider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "anthropic-compatible")!;
    const openaiBody = buildOpenAIResponsesBody(openaiProvider, "{}", "Plan a feature", false, "planning", resolvePhaseModelPolicy(openaiProvider, "planning"));
    const anthropicBody = buildAnthropicCompatibleBody(anthropicProvider, "{}", "Plan a feature", false, "planning", resolvePhaseModelPolicy(anthropicProvider, "planning"));
    const prompt = `${JSON.stringify(openaiBody)}\n${JSON.stringify(anthropicBody)}`;

    expect(prompt).toContain("Planning handoff JSON contract");
    expect(prompt).toContain("top-level shape: { \\\"archicodePatch\\\": { ... } }");
    expect(prompt).toContain("Do not return the bare patch object");
    expect(prompt).toContain("Goal, Approach, Key Assumptions, Implementation Steps, Verification, Risks");
    expect(prompt).toContain("\\\"goal\\\": string");
    expect(prompt).toContain("\\\"approach\\\": string");
    expect(prompt).toContain("\\\"implementationTasks\\\": [");
    expect(prompt).toContain("During planning, never return propose-source-file operations");
  });

  it("surfaces incomplete OpenAI Responses payloads with retry guidance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "reasoning", content: [] }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    ));
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKey: "sk-test",
      openAiEndpointMode: "responses" as const
    };

    await expect(callProvider(provider, "{}", "Code a feature", { phase: "coding" }))
      .rejects.toThrow(/incomplete response \(max_output_tokens\).*Max output/);
  });

  it("does not collapse empty completed OpenAI Responses payloads to a blank string", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        status: "completed",
        output: []
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    ));
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKey: "sk-test",
      openAiEndpointMode: "responses" as const
    };

    await expect(callProvider(provider, "{}", "Plan a feature", { phase: "planning" }))
      .resolves.toBe("Provider returned no content.");
  });

  it("retries OpenAI-compatible research chat calls without context-only image payloads when image_url is rejected", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-provider-image-retry-"));
    const imagePath = path.join(root, "context-image.png");
    await writeFile(imagePath, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    ));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: "Failed to deserialize the JSON body into the target type: messages[1]: unknown variant `image_url`, expected `text`",
          type: "invalid_request_error",
          code: "invalid_request_error"
        }
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      }))
      .mockResolvedValueOnce(streamingChatCompletionResponse("Retried without context images."));
    vi.stubGlobal("fetch", fetchMock);
    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKey: "sk-test",
      openAiEndpointMode: "chat-completions" as const
    };

    const output = await callResearchProvider(provider, "What does the attached screenshot in the node note show?", {
      scopeContext: "{}",
      messages: [],
      imageAttachments: [{
        title: "context-image.png",
        path: imagePath,
        mediaType: "image/png",
        source: "context" as const,
        sourceLabel: "scoped graph note"
      }]
    });

    const firstBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const secondBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const firstUserMessage = firstBody.messages.find((message) => message.role === "user");
    const secondUserMessage = secondBody.messages.find((message) => message.role === "user");

    expect(Array.isArray(firstUserMessage?.content)).toBe(true);
    expect(JSON.stringify(firstUserMessage?.content)).toContain("image_url");
    expect(Array.isArray(secondUserMessage?.content)).toBe(false);
    expect(output).toBe("Retried without context images.");
  });

  it("pushes API planning runs to choose between asking questions and proceeding", () => {
    const openaiProvider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!;
    const anthropicProvider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "anthropic-compatible")!;
    const openaiBody = buildOpenAICompatibleBody(openaiProvider, "{}", "Plan a feature", false, "planning", resolvePhaseModelPolicy(openaiProvider, "planning"));
    const anthropicBody = buildAnthropicCompatibleBody(anthropicProvider, "{}", "Plan a feature", false, "planning", resolvePhaseModelPolicy(anthropicProvider, "planning"));
    const combined = `${JSON.stringify(openaiBody)}\n${JSON.stringify(anthropicBody)}`;

    expect(combined).toContain("Decision: ask_questions");
    expect(combined).toContain("Decision: proceed");
    expect(combined).toContain("materially change the files, UX, architecture");
    expect(combined).toContain("only add-note operations using kind llm-question");
    expect(anthropicBody.max_tokens).toBe(16000);
    expect(anthropicBody.output_config).toEqual({ effort: "medium" });
  });

  it("adds reasoning controls only for supported OpenAI-compatible models", () => {
    const seed = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!;
    const nonReasoningProvider = { ...seed, model: "gpt-4.1" };
    const unsupported = buildOpenAICompatibleBody(nonReasoningProvider, "{}", "Plan", false, "planning", resolvePhaseModelPolicy(nonReasoningProvider, "planning"));
    const reasoningProvider = { ...seed, model: "o3" };
    const supported = buildOpenAICompatibleBody(reasoningProvider, "{}", "Plan", false, "planning", resolvePhaseModelPolicy(reasoningProvider, "planning"));

    expect(unsupported.reasoning_effort).toBeUndefined();
    expect(supported.reasoning_effort).toBe("high");
  });

  it("uses adaptive Anthropic thinking for Sonnet 4.6", () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "anthropic-compatible")!;
    const body = buildAnthropicCompatibleBody(provider, "{}", "Debug", false, "debugging", resolvePhaseModelPolicy(provider, "debugging"));

    expect(body.max_tokens).toBe(32000);
    expect(body.temperature).toBe(1);
    expect(body.thinking).toEqual({ type: "adaptive", display: "omitted" });
    expect(body.output_config).toEqual({ effort: "medium" });
  });

  it("retries Anthropic implementation calls without thinking when thinking exhausts max tokens", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"input_tokens":6178,"output_tokens":16000,"output_tokens_details":{"thinking_tokens":16000}}}\n\n'));
          controller.close();
        }
      }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      }))
      .mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Visible plan text"}}\n\n'));
          controller.enqueue(encoder.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'));
          controller.close();
        }
      }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "anthropic-compatible")!,
      apiKey: "sk-ant-test"
    };
    const progress: string[] = [];

    await expect(callProvider(provider, "{}", "Plan a feature", {
      phase: "planning",
      onProgress: (event) => progress.push(event.text)
    })).resolves.toBe("Visible plan text");
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>;
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(firstBody.max_tokens).toBe(16000);
    expect(firstBody.thinking).toEqual({ type: "adaptive", display: "omitted" });
    expect(firstBody.output_config).toEqual({ effort: "medium" });
    expect(secondBody.thinking).toBeUndefined();
    expect(secondBody.output_config).toBeUndefined();
    expect(secondBody.temperature).toBe(0.2);
    expect(progress.join("\n")).toContain("Retrying once without Anthropic thinking controls");
  });

  it("keeps manual Anthropic thinking budgets for non-adaptive Claude models", () => {
    const seed = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "anthropic-compatible")!;
    const provider = { ...seed, model: "claude-haiku-4-5" };
    const body = buildAnthropicCompatibleBody(provider, "{}", "Debug", false, "debugging", resolvePhaseModelPolicy(provider, "debugging"));

    expect(body.temperature).toBe(1);
    expect(body.thinking).toEqual(expect.objectContaining({ type: "enabled", budget_tokens: expect.any(Number) }));
    expect(body.output_config).toBeUndefined();
  });

  it("treats Claude Sonnet 5 as an adaptive Anthropic thinking model", () => {
    const seed = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "anthropic-compatible")!;
    const provider = { ...seed, model: "claude-sonnet-5" };
    const body = buildAnthropicCompatibleBody(provider, "{}", "Plan", false, "planning", resolvePhaseModelPolicy(provider, "planning"));

    expect(body.thinking).toEqual({ type: "adaptive", display: "omitted" });
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body.max_tokens).toBe(16000);
  });

  it("uses configured Anthropic temperature when thinking is disabled", () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "anthropic-compatible")!;
    const policy = {
      ...resolvePhaseModelPolicy(provider, "brainstorming"),
      reasoningMode: "off" as const,
      temperature: 0.6
    };
    const body = buildAnthropicCompatibleBody(provider, "{}", "Chat", false, "brainstorming", policy);

    expect(body.temperature).toBe(0.6);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it("does not pass fake temperature or reasoning flags to Codex Local", () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "codex-local")!;
    const args = buildCodexLocalArgs(provider, { phase: "coding" }, "/tmp/out.txt");
    const profile = inferModelCapabilityProfile(provider);

    expect(args).not.toContain("--temperature");
    expect(args).not.toContain("--reasoning");
    expect(args).toContain("--ask-for-approval");
    expect(args).toContain("mcp_servers.archicode.enabled=false");
    expect(args.indexOf("--ask-for-approval")).toBeLessThan(args.indexOf("exec"));
    expect(args.indexOf("mcp_servers.archicode.enabled=false")).toBeLessThan(args.indexOf("exec"));
    expect(profile.reasoningField).toBe("prompt-only");
  });

  it("attaches image inputs to Codex Local invocations instead of passing paths only as text", () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "codex-local")!;
    const imageAttachments = [{
      title: "Delphi capture",
      path: "/tmp/archicode/capture.png",
      mediaType: "image/png" as const,
      source: "context" as const
    }];
    const runArgs = buildCodexLocalArgs(provider, { phase: "brainstorming", imageAttachments }, "/tmp/out.txt");
    const researchArgs = buildCodexLocalResearchArgs(provider, {
      projectRoot: "/tmp/archicode",
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      imageAttachments
    }, "/tmp/research-out.txt");

    expect(runArgs).toEqual(expect.arrayContaining(["--image", "/tmp/archicode/capture.png"]));
    expect(researchArgs).toEqual(expect.arrayContaining(["--image", "/tmp/archicode/capture.png"]));
    expect(runArgs.indexOf("--image")).toBeGreaterThan(runArgs.indexOf("exec"));
    expect(researchArgs.indexOf("--image")).toBeGreaterThan(researchArgs.indexOf("exec"));
  });

  it("passes output verbosity to every Codex Local invocation as an in-memory config override", () => {
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "codex-local")!,
      outputVerbosity: "medium" as const
    };
    const runArgs = buildCodexLocalArgs(provider, { phase: "coding" }, "/tmp/out.txt");
    const researchArgs = buildCodexLocalResearchArgs(provider, {
      projectRoot: "/tmp/archicode",
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: []
    }, "/tmp/research-out.txt");

    expect(runArgs).toEqual(expect.arrayContaining(["--config", 'model_verbosity="medium"']));
    expect(researchArgs).toEqual(expect.arrayContaining(["--config", 'model_verbosity="medium"']));
    expect(runArgs.indexOf('model_verbosity="medium"')).toBeLessThan(runArgs.indexOf("exec"));
    expect(researchArgs.indexOf('model_verbosity="medium"')).toBeLessThan(researchArgs.indexOf("exec"));
  });

  it("leaves Codex Local verbosity unset when Model default is selected", () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "codex-local")!;
    const args = buildCodexLocalArgs(provider, { phase: "planning" }, "/tmp/out.txt");

    expect(args.some((arg) => arg.startsWith("model_verbosity="))).toBe(false);
  });

  it("passes Codex Local research through read-only search args", () => {
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "codex-local")!,
      localSandbox: "workspace-write" as const
    };
    const args = buildCodexLocalResearchArgs(provider, {
      projectRoot: "/tmp/archicode",
      webSearchEnabled: true,
      scopeContext: "{}",
      messages: []
    }, "/tmp/out.txt");

    expect(args).toContain("--search");
    expect(args).toContain("mcp_servers.archicode.enabled=false");
    expect(args).toContain("read-only");
    expect(args.indexOf("--search")).toBeLessThan(args.indexOf("exec"));
    expect(args.indexOf("mcp_servers.archicode.enabled=false")).toBeLessThan(args.indexOf("exec"));
  });

  it("maps Claude Local planning/coding access to permission modes", () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "claude-local")!;
    const planningArgs = buildClaudeLocalArgs(provider, { phase: "planning" });
    const codingArgs = buildClaudeLocalArgs({ ...provider, localSandbox: "workspace-write" as const }, { phase: "coding" });
    const fullAccessArgs = buildClaudeLocalArgs({ ...provider, localSandbox: "danger-full-access" as const }, { phase: "coding" });

    expect(planningArgs).toEqual(expect.arrayContaining(["--print", "--permission-mode", "dontAsk"]));
    expect(codingArgs).toEqual(expect.arrayContaining(["--permission-mode", "acceptEdits", "--allowedTools"]));
    expect(fullAccessArgs).toEqual(expect.arrayContaining(["--permission-mode", "bypassPermissions", "--allow-dangerously-skip-permissions"]));
    expect(planningArgs).toContain("Bash");
    expect(codingArgs).toContain("Edit");
    expect(codingArgs).toContain("Bash");
  });

  it("passes Claude Local research through MCP allowlists plus web search", () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "claude-local")!;
    const args = buildClaudeLocalResearchArgs(provider, {
      projectRoot: "/tmp/archicode",
      webSearchEnabled: true,
      scopeContext: "{}",
      messages: []
    }, {
      mcpConfigPath: "/tmp/claude-mcp.json",
      allowedToolPatterns: ["mcp__archicode-project-files__*"]
    });

    expect(args).toEqual(expect.arrayContaining([
      "--verbose",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--mcp-config",
      "/tmp/claude-mcp.json",
      "--strict-mcp-config",
      "--allowedTools",
      "mcp__archicode-project-files__*",
      "WebSearch",
      "WebFetch(domain:*)"
    ]));
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--add-dir");
  });

  it("streams Claude Local research stream-json message updates through the token callback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-claude-research-stream-"));
    const commandPath = path.join(root, "fake-claude-stream.cjs");
    await writeFile(commandPath, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "Hello" }]
    }
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "Hello Claude" }]
    }
  }) + "\\n");
  process.exit(0);
});
`, "utf8");
    await chmod(commandPath, 0o755);
    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "claude-local")!,
      localCommand: commandPath
    };
    const chunks: string[] = [];

    await expect(callResearchProvider(provider, "Hello", {
      projectRoot: root,
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      onToken: (text) => chunks.push(text)
    })).resolves.toBe("Hello Claude");

    expect(chunks).toEqual(["Hello", " Claude"]);
  });

  it("reconstructs Claude Local research answers when continuation text arrives through content_block events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-claude-research-content-block-"));
    const commandPath = path.join(root, "fake-claude-content-block.cjs");
    await writeFile(commandPath, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "I can add a Contact Page node.\\n- Type: task\\n-" }]
    }
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "content_block_start",
    content_block: { type: "text", text: " Route: /contact" }
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "content_block_start",
    content_block: { type: "text", text: "\\n- Include a simple contact form and contact details." }
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    stop_reason: "end_turn"
  }) + "\\n");
  process.exit(0);
});
`, "utf8");
    await chmod(commandPath, 0o755);
    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "claude-local")!,
      localCommand: commandPath
    };
    const chunks: string[] = [];

    await expect(callResearchProvider(provider, "Describe the node", {
      projectRoot: root,
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      onToken: (text) => chunks.push(text)
    })).resolves.toBe("I can add a Contact Page node.\n- Type: task\n- Route: /contact\n- Include a simple contact form and contact details.");

    expect(chunks).toEqual([
      "I can add a Contact Page node.\n- Type: task\n-",
      " Route: /contact",
      "\n- Include a simple contact form and contact details."
    ]);
  });

  it("passes trusted MCP servers to Codex Local research exec config", () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "codex-local")!;
    const args = buildCodexLocalResearchArgs(provider, {
      projectRoot: "/tmp/archicode",
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      mcpServers: [
        {
          id: "context7",
          label: "Context7",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
          env: [{ name: "CONTEXT7_API_KEY", value: "secret" }],
          headers: [],
          defaultToolsApprovalMode: "approve",
          enabled: true,
          trusted: true,
          source: "project",
          tools: [],
          resources: [],
          prompts: []
        },
        {
          id: "untrusted-docs",
          label: "Untrusted Docs",
          transport: "streamable-http",
          url: "https://example.com/mcp",
          enabled: true,
          trusted: false,
          source: "project",
          args: [],
          env: [],
          headers: [],
          tools: [],
          resources: [],
          prompts: []
        }
      ]
    }, "/tmp/out.txt");

    expect(args.join("\n")).toContain("mcp_servers.context7.command=\"npx\"");
    expect(args.join("\n")).toContain("mcp_servers.context7.args=[\"-y\",\"@upstash/context7-mcp\"]");
    expect(args.join("\n")).toContain("mcp_servers.context7.env.CONTEXT7_API_KEY=\"secret\"");
    expect(args.join("\n")).toContain("mcp_servers.context7.default_tools_approval_mode=\"approve\"");
    expect(args.join("\n")).not.toContain("untrusted-docs");
  });

  it("builds OpenAI Responses web-search requests for research", async () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!;
    const body = await buildOpenAIResearchResponsesBody(provider, "Research current docs", {
      projectRoot: "/tmp/archicode",
      webSearchEnabled: true,
      scopeContext: "{}",
      messages: []
    }, resolvePhaseModelPolicy(provider, "brainstorming"));

    expect(body.tools).toEqual([{ type: "web_search" }]);
    const prompt = JSON.stringify(body);
    expect(prompt).toContain("Research changeSet JSON contract");
    expect(prompt).toContain("top-level shape: { \\\"archicodeResearch\\\": { ... } }");
    expect(prompt).toContain("Do not return a bare object");
    expect(prompt).toContain("\\\"changeSet\\\": {");
    expect(prompt).toContain("\\\"kind\\\": \\\"start-agent-run\\\"");
    expect(prompt).toContain("\\\"guidance\\\": {");
    expect(prompt).toContain("AI Implement can create a new codebase from the graph");
    expect(prompt).toContain("Gaia — Build & Implementation");
    expect(prompt).toContain("focused repairs belong to Pandora through AI Debug");
    expect(prompt).toContain("Do not include guidance on start-run-profile");
    expect(prompt).toContain("Do not include providerId in queue action operations.");
    expect(prompt).not.toContain("\\\"providerId\\\": \\\"openai-compatible\\\"");
  });

  it("uses a strict empty schema for MCP tools without declared inputs", async () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!;
    const body = await buildOpenAIResearchResponsesBody(provider, "Use a no-arg MCP tool", {
      projectRoot: "/tmp/archicode",
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      mcpTools: [{
        providerToolName: "mcp_project_noop",
        serverId: "project",
        serverLabel: "Project",
        toolName: "noop"
      }]
    }, resolvePhaseModelPolicy(provider, "brainstorming"));
    const tool = (body.tools as Array<Record<string, unknown>>).find((item) => item.name === "mcp_project_noop");

    expect(tool?.parameters).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {}
    });
  });

  it("streams OpenAI Responses research text deltas through the token callback", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n'));
          controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" OpenAI"}\n\n'));
          controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'));
          controller.close();
        }
      }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKey: "sk-test",
      openAiEndpointMode: "responses" as const
    };
    const chunks: string[] = [];

    await expect(callResearchProvider(provider, "Hello", {
      projectRoot: "/tmp/archicode",
      webSearchEnabled: true,
      scopeContext: "{}",
      messages: [],
      onToken: (text) => chunks.push(text)
    })).resolves.toBe("Hello OpenAI");
    const fetchOptions = fetchMock.mock.calls[0]?.[1] as { body?: unknown } | undefined;
    const body = JSON.parse(String(fetchOptions?.body)) as Record<string, unknown>;

    expect(chunks).toEqual(["Hello", " OpenAI"]);
    expect(body.stream).toBe(true);
    expect(body.tools).toEqual([{ type: "web_search" }]);
  });

  it("retries a transient OpenAI Responses terminal failure before any visible output", async () => {
    const encoder = new TextEncoder();
    const eventChunk = (event: Record<string, unknown>) =>
      encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const fetchMock = vi.fn(async () => {
      const callIndex = fetchMock.mock.calls.length;
      return new Response(new ReadableStream({
        start(controller) {
          if (callIndex === 1) {
            controller.enqueue(eventChunk({
              type: "response.failed",
              response: { status: "failed", error: { message: "Internal Server Error" }, output: [] }
            }));
          } else {
            controller.enqueue(eventChunk({ type: "response.output_text.delta", delta: "Recovered after retry." }));
            controller.enqueue(eventChunk({
              type: "response.completed",
              response: { status: "completed", output: [] }
            }));
          }
          controller.close();
        }
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKey: "sk-test",
      openAiEndpointMode: "responses" as const
    };
    const chunks: string[] = [];

    await expect(callResearchProvider(provider, "Continue", {
      projectRoot: "/tmp/archicode",
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      onToken: (text) => chunks.push(text)
    })).resolves.toBe("Recovered after retry.");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(chunks).toEqual(["Recovered after retry."]);
  });

  it("retries OpenRouter's upstream idle timeout before any tool output", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "failed",
        error: { message: "Upstream idle timeout exceeded" },
        output: []
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "completed",
        output_text: "Recovered bounded batch.",
        output: []
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKey: "sk-test",
      openAiEndpointMode: "responses" as const
    };

    await expect(callResearchProvider(provider, "Continue the bounded task", {
      projectRoot: "/tmp/archicode",
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: []
    })).resolves.toBe("Recovered bounded batch.");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a transient OpenAI Responses failure after visible output was emitted", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Partial answer"}\n\n'));
        controller.enqueue(encoder.encode('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"message":"Internal Server Error"},"output":[]}}\n\n'));
        controller.close();
      }
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKey: "sk-test",
      openAiEndpointMode: "responses" as const
    };
    const chunks: string[] = [];

    await expect(callResearchProvider(provider, "Continue", {
      projectRoot: "/tmp/archicode",
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      onToken: (text) => chunks.push(text)
    })).rejects.toThrow("Internal Server Error");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual(["Partial answer"]);
  });

  it("continues OpenAI Responses research when terminal sink tools return no visible text", async () => {
    const encoder = new TextEncoder();
    const eventChunk = (event: Record<string, unknown>) =>
      encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
      const callIndex = fetchMock.mock.calls.length;
      return new Response(new ReadableStream({
        start(controller) {
          if (callIndex === 1) {
            controller.enqueue(eventChunk({
              type: "response.completed",
              response: {
                id: "resp-memory-only",
                status: "completed",
                output: [{
                  type: "function_call",
                  call_id: "call-memory",
                  name: "archicode_update_memory",
                  arguments: "{\"summary\":\"Greeted the user.\"}"
                }]
              }
            }));
          } else {
            controller.enqueue(eventChunk({ type: "response.output_text.delta", delta: "Hi from Archi." }));
            controller.enqueue(eventChunk({
              type: "response.completed",
              response: { id: "resp-visible", status: "completed", output: [] }
            }));
          }
          controller.close();
        }
      }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKey: "sk-test",
      openAiEndpointMode: "responses" as const
    };
    const calls: string[] = [];

    await expect(callResearchProvider(provider, "hi", {
      projectRoot: "/tmp/archicode",
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      onToken: () => {},
      mcpTools: [{
        providerToolName: "archicode_update_memory",
        serverId: "archicode-research-internal",
        serverLabel: "Research",
        toolName: "update_memory"
      }],
      isTerminalTool: (providerToolName) => providerToolName === "archicode_update_memory",
      callMcpTool: async (input) => {
        calls.push(input.providerToolName);
        return "Research memory recorded.";
      }
    })).resolves.toBe("Hi from Archi.");

    expect(calls).toEqual(["archicode_update_memory"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const continuation = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as { body?: unknown } | undefined)?.body)) as Record<string, unknown>;
    expect(continuation.previous_response_id).toBeUndefined();
    expect(JSON.stringify(continuation.input)).toContain("User message: hi");
    expect(JSON.stringify(continuation.input)).toContain('"type":"function_call"');
    expect(JSON.stringify(continuation.input)).toContain('"type":"function_call_output"');
    expect(JSON.stringify(continuation.input)).toContain("call-memory");
    expect(continuation.tools).toBeUndefined();
    expect(continuation.tool_choice).toBe("none");
  });

  it("allows repeated OpenAI Responses tool calls beyond the former hard limit", async () => {
    const fetchMock = vi.fn(async () => {
      const requestNumber = fetchMock.mock.calls.length;
      if (requestNumber > 12) {
        return new Response(JSON.stringify({
          id: `resp-${requestNumber}`,
          status: "completed",
          output_text: "Finished after the tool work."
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const callId = `call-read-${requestNumber}`;
      return new Response(JSON.stringify({
        id: `resp-${requestNumber}`,
        status: "completed",
        output: [{ type: "function_call", call_id: callId, name: "picasso_read_graph", arguments: JSON.stringify({ step: requestNumber }) }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKey: "sk-test",
      openAiEndpointMode: "responses" as const
    };
    const toolCalls: string[] = [];

    await expect(callResearchProvider(provider, "Build the graph", {
      projectRoot: "/tmp/archicode",
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      mcpTools: [{
        providerToolName: "picasso_read_graph",
        serverId: "archicode-subagents",
        serverLabel: "Picasso",
        toolName: "read_graph"
      }],
      callMcpTool: async (input) => {
        toolCalls.push(input.providerToolName);
        return "{\"project\":{\"id\":\"project-seed\"},\"flows\":[]}";
      }
    })).resolves.toBe("Finished after the tool work.");

    expect(fetchMock).toHaveBeenCalledTimes(13);
    expect(toolCalls).toHaveLength(12);
    expect(toolCalls.every((name) => name === "picasso_read_graph")).toBe(true);
  });

  it("stops only a consecutive run of three identical OpenAI Responses tool calls", async () => {
    const argumentSequence = [
      { path: "package.json" },
      { path: "src/App.ts" },
      { path: "package.json" },
      { path: "package.json" },
      { path: "package.json" }
    ];
    const fetchMock = vi.fn(async () => {
      const requestNumber = fetchMock.mock.calls.length;
      const args = argumentSequence[requestNumber - 1] ?? argumentSequence.at(-1)!;
      return new Response(JSON.stringify({
        id: `resp-${requestNumber}`,
        status: "completed",
        output: [{
          type: "function_call",
          call_id: `call-read-${requestNumber}`,
          name: "archicode_project_read_file",
          arguments: JSON.stringify(args)
        }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKey: "sk-test",
      openAiEndpointMode: "responses" as const
    };
    const toolCalls: string[] = [];

    await expect(callResearchProvider(provider, "Inspect files", {
      projectRoot: "/tmp/archicode",
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      mcpTools: [{
        providerToolName: "archicode_project_read_file",
        serverId: "archicode-internal-tools",
        serverLabel: "ArchiCode Tools",
        toolName: "read_file"
      }],
      callMcpTool: async (input) => {
        toolCalls.push(input.argumentsJson);
        return "file contents";
      }
    })).rejects.toThrow("Consecutive identical tool-call loop detected for archicode_project_read_file; stopped on attempt 3.");

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(toolCalls).toHaveLength(4);
  });

  it("recovers trailing research chat text from a terminal chat-completions message chunk", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Great - here is the graph plan"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"message":{"content":"Great - here is the graph plan with the missing ending."},"finish_reason":"stop"}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      apiKey: "sk-test",
      openAiEndpointMode: "chat-completions" as const
    };
    const chunks: string[] = [];

    await expect(callResearchProvider(provider, "Hello", {
      projectRoot: "/tmp/archicode",
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      onToken: (text) => chunks.push(text)
    })).resolves.toBe("Great - here is the graph plan with the missing ending.");
    const fetchOptions = fetchMock.mock.calls[0]?.[1] as { body?: unknown } | undefined;
    const body = JSON.parse(String(fetchOptions?.body)) as Record<string, unknown>;

    expect(chunks).toEqual([
      "Great - here is the graph plan",
      " with the missing ending."
    ]);
    expect(body.stream).toBe(true);
  });

  it("builds Anthropic web-search requests for research", async () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "anthropic-compatible")!;
    const body = await buildAnthropicResearchBody(provider, "Research current docs", {
      projectRoot: "/tmp/archicode",
      webSearchEnabled: true,
      scopeContext: "{}",
      messages: []
    }, resolvePhaseModelPolicy(provider, "brainstorming"));

    expect(body.tools).toEqual([{ type: "web_search_20260318", name: "web_search" }]);
    expect(body.max_tokens).toBe(24000);
    expect(body.temperature).toBe(1);
    expect(body.thinking).toEqual({ type: "adaptive", display: "omitted" });
    expect(body.output_config).toEqual({ effort: "medium" });
    const prompt = JSON.stringify(body);
    expect(prompt).toContain("Research changeSet JSON contract");
    expect(prompt).toContain("top-level shape: { \\\"archicodeResearch\\\": { ... } }");
    expect(prompt).toContain("Do not return a bare object");
    expect(prompt).toContain("\\\"changeSet\\\": {");
    expect(prompt).toContain("\\\"kind\\\": \\\"start-agent-run\\\"");
  });

  it("streams Anthropic research text deltas through the token callback", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n'));
          controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}\n\n'));
          controller.enqueue(encoder.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'));
          controller.close();
        }
      }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "anthropic-compatible")!,
      apiKey: "sk-ant-test"
    };
    const chunks: string[] = [];

    await expect(callResearchProvider(provider, "Hello", {
      projectRoot: "/tmp/archicode",
      webSearchEnabled: true,
      scopeContext: "{}",
      messages: [],
      onToken: (text) => chunks.push(text)
    })).resolves.toBe("Hello world");
    const fetchOptions = fetchMock.mock.calls[0]?.[1] as { body?: unknown } | undefined;
    const body = JSON.parse(String(fetchOptions?.body)) as Record<string, unknown>;

    expect(chunks).toEqual(["Hello", " world"]);
    expect(body.stream).toBe(true);
    expect(body.tools).toEqual([{ type: "web_search_20260318", name: "web_search" }]);
  });

  it("streams Codex Local research JSON message deltas through the token callback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-codex-research-stream-"));
    const commandPath = path.join(root, "fake-codex-stream.cjs");
    await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("fs");
const outIndex = process.argv.indexOf("--output-last-message");
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "agent_message_delta", delta: "Hello" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "agent_message_delta", delta: " Codex" }) + "\\n");
  if (outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], "Hello Codex", "utf8");
  process.exit(0);
});
`, "utf8");
    await chmod(commandPath, 0o755);
    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "codex-local")!,
      localCommand: commandPath
    };
    const chunks: string[] = [];

    await expect(callResearchProvider(provider, "Hello", {
      projectRoot: root,
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      onToken: (text) => chunks.push(text)
    })).resolves.toBe("Hello Codex");

    expect(chunks).toEqual(["Hello", " Codex"]);
  });

  it("resets and streams every later Codex Local research tool-loop iteration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-codex-research-multiturn-stream-"));
    const commandPath = path.join(root, "fake-codex-multiturn.cjs");
    const countPath = path.join(root, "count.txt");
    await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("fs");
const outIndex = process.argv.indexOf("--output-last-message");
let count = 0;
try { count = Number(fs.readFileSync(${JSON.stringify(countPath)}, "utf8")); } catch {}
count += 1;
fs.writeFileSync(${JSON.stringify(countPath)}, String(count), "utf8");
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk.toString(); });
process.stdin.on("end", () => {
  const message = count === 1
    ? JSON.stringify({ archicodeResearchTurn: { answer: "I’ll inspect the project first.", toolCalls: [{ id: "read-1", providerToolName: "archicode_project_read_file", arguments: { path: "README.md" } }] } })
    : stdin.includes("Continue the same task from the structured transcript below") &&
        stdin.includes("Assistant text beside tool calls is progress from this same trajectory") &&
        stdin.includes("Assistant answer: I’ll inspect the project first.") &&
        stdin.includes("Tool result for archicode_project_read_file: README evidence")
      ? "Final answer from the parent continuation."
      : "Missing post-tool continuation requirement.";
  process.stdout.write(JSON.stringify({ type: "agent_message_delta", delta: message }) + "\\n");
  if (outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], message, "utf8");
  process.exit(0);
});
`, "utf8");
    await chmod(commandPath, 0o755);
    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "codex-local")!,
      localCommand: commandPath
    };
    const chunks: string[] = [];
    let resets = 0;

    await expect(callResearchProvider(provider, "Inspect this", {
      projectRoot: root,
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      onToken: (text) => chunks.push(text),
      onTokenReset: () => { resets += 1; },
      mcpTools: [{
        providerToolName: "archicode_project_read_file",
        serverId: "archicode-project-files",
        serverLabel: "Project Files",
        toolName: "read_file"
      }],
      callMcpTool: async () => "README evidence",
      isTerminalTool: () => false
    })).resolves.toBe("Final answer from the parent continuation.");

    expect(resets).toBe(1);
    expect(chunks.at(-1)).toBe("Final answer from the parent continuation.");
    expect(await readFile(countPath, "utf8")).toBe("2");
  });

  it("repairs malformed Codex Local tool envelopes on the same trajectory instead of exposing them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-codex-research-malformed-turn-"));
    const commandPath = path.join(root, "fake-codex-malformed-turn.cjs");
    const countPath = path.join(root, "count.txt");
    const malformedTurn = '```json\n{"archicodeResearchTurn":{"toolCalls":[{"id":"read-1","providerToolName":"archicode_project_read_file","arguments":{"path":"README.md}}]}}}\n```';
    await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("fs");
const outIndex = process.argv.indexOf("--output-last-message");
let count = 0;
try { count = Number(fs.readFileSync(${JSON.stringify(countPath)}, "utf8")); } catch {}
count += 1;
fs.writeFileSync(${JSON.stringify(countPath)}, String(count), "utf8");
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk.toString(); });
process.stdin.on("end", () => {
  const message = count === 1
    ? ${JSON.stringify(malformedTurn)}
    : count === 2 && stdin.includes("could not parse it as a valid tool turn")
      ? JSON.stringify({ archicodeResearchTurn: { toolCalls: [{ id: "read-1", providerToolName: "archicode_project_read_file", arguments: { path: "README.md" } }] } })
      : count === 3 && stdin.includes("README evidence")
        ? "Recovered final answer after the corrected project read."
        : "Malformed-turn recovery context was missing.";
  if (outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], message, "utf8");
  process.exit(0);
});
`, "utf8");
    await chmod(commandPath, 0o755);
    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "codex-local")!,
      localCommand: commandPath
    };
    const calls: string[] = [];

    await expect(callResearchProvider(provider, "Inspect README", {
      projectRoot: root,
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      mcpTools: [{
        providerToolName: "archicode_project_read_file",
        serverId: "archicode-project-files",
        serverLabel: "Project Files",
        toolName: "read_file"
      }],
      callMcpTool: async (input) => {
        calls.push(input.providerToolName);
        return "README evidence";
      },
      isTerminalTool: () => false
    })).resolves.toBe("Recovered final answer after the corrected project read.");

    expect(calls).toEqual(["archicode_project_read_file"]);
    expect(await readFile(countPath, "utf8")).toBe("3");
  });

  it("feeds local CLI tool validation failures back for a schema-corrected retry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-codex-research-tool-schema-repair-"));
    const commandPath = path.join(root, "fake-codex-tool-schema-repair.cjs");
    const countPath = path.join(root, "count.txt");
    await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("fs");
const outIndex = process.argv.indexOf("--output-last-message");
let count = 0;
try { count = Number(fs.readFileSync(${JSON.stringify(countPath)}, "utf8")); } catch {}
count += 1;
fs.writeFileSync(${JSON.stringify(countPath)}, String(count), "utf8");
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk.toString(); });
process.stdin.on("end", () => {
  const message = count === 1 && stdin.includes('"required":["title","body"]')
    ? JSON.stringify({ archicodeResearchTurn: { toolCalls: [{ id: "remember-1", providerToolName: "archicode_project_remember_note", arguments: { key: "user-name", body: "The user's name is Roy." } }] } })
    : count === 2 && stdin.includes("title is required")
      ? JSON.stringify({ archicodeResearchTurn: { toolCalls: [{ id: "remember-2", providerToolName: "archicode_project_remember_note", arguments: { title: "User name", body: "The user's name is Roy.", pinned: true } }] } })
      : count === 3 && stdin.includes("Stored Roy")
        ? "I’ll remember that your name is Roy."
        : "Schema repair context was missing.";
  if (outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], message, "utf8");
  process.exit(0);
});
`, "utf8");
    await chmod(commandPath, 0o755);
    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "codex-local")!,
      localCommand: commandPath
    };
    const calls: string[] = [];

    await expect(callResearchProvider(provider, "Remember that my name is Roy", {
      projectRoot: root,
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      mcpTools: [{
        providerToolName: "archicode_project_remember_note",
        serverId: "archicode-project-files",
        serverLabel: "Project Memory & Chat Artifacts",
        toolName: "remember_note",
        description: "Create a durable project memory note.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["title", "body"],
          properties: {
            title: { type: "string" },
            body: { type: "string" },
            pinned: { type: "boolean" }
          }
        }
      }],
      callMcpTool: async (input) => {
        calls.push(input.argumentsJson);
        const args = JSON.parse(input.argumentsJson) as { title?: string };
        if (!args.title) throw new Error("title is required.");
        return "Stored Roy";
      },
      isTerminalTool: () => false
    })).resolves.toBe("I’ll remember that your name is Roy.");

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('"key":"user-name"');
    expect(calls[1]).toContain('"title":"User name"');
    expect(await readFile(countPath, "utf8")).toBe("3");
  });

  it("keeps Codex Local on the same trajectory after non-terminal bookkeeping tools until it returns a visible answer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-codex-research-finalized-outcome-"));
    const commandPath = path.join(root, "fake-codex-finalized-outcome.cjs");
    const countPath = path.join(root, "count.txt");
    await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("fs");
const outIndex = process.argv.indexOf("--output-last-message");
let count = 0;
try { count = Number(fs.readFileSync(${JSON.stringify(countPath)}, "utf8")); } catch {}
count += 1;
fs.writeFileSync(${JSON.stringify(countPath)}, String(count), "utf8");
process.stdin.resume();
process.stdin.on("end", () => {
  const message = count === 1 ? JSON.stringify({
    archicodeResearchTurn: {
      answer: "Recording optional bookkeeping before the final answer.",
      toolCalls: [
        {
          id: "checkpoint-final",
          providerToolName: "archicode_checkpoint_goal",
          arguments: { status: "blocked", summary: "Visual coverage remains blocked." }
        },
        {
          id: "memory-final",
          providerToolName: "archicode_update_memory",
          arguments: { summary: "Functional audit passed; visual coverage remains blocked." }
        }
      ]
    }
  }) : "The functional audit passed; visual coverage remains blocked.";
  if (outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], message, "utf8");
  process.exit(0);
});
`, "utf8");
    await chmod(commandPath, 0o755);
    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "codex-local")!,
      localCommand: commandPath
    };
    const calls: string[] = [];

    await expect(callResearchProvider(provider, "Finalize the audit outcome", {
      projectRoot: root,
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      mcpTools: [
        { providerToolName: "archicode_checkpoint_goal", serverId: "archicode-research-internal", serverLabel: "Research", toolName: "checkpoint_goal" },
        { providerToolName: "archicode_update_memory", serverId: "archicode-research-internal", serverLabel: "Research", toolName: "update_memory" }
      ],
      isTerminalTool: () => false,
      callMcpTool: async (input) => {
        calls.push(input.providerToolName);
        return input.providerToolName === "archicode_checkpoint_goal"
          ? JSON.stringify({ status: "goal-checkpoint-recorded" })
          : "Research memory recorded.";
      }
    })).resolves.toBe("The functional audit passed; visual coverage remains blocked.");

    expect(calls).toEqual(["archicode_checkpoint_goal", "archicode_update_memory"]);
    expect(await readFile(countPath, "utf8")).toBe("2");
  });

  it("keeps isolated Codex Local subagent tool loops free of parent Research obligations", () => {
    const instructions = localResearchToolLoopInstructions({
      projectRoot: "/tmp/archicode",
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      systemInstructionsOverride: "You are Delphi.",
      mcpTools: [
        {
          providerToolName: "delphi_inspect_test_environment",
          serverId: "delphi",
          serverLabel: "Delphi",
          toolName: "inspect",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["target"],
            properties: { target: { type: "string" } }
          }
        },
        { providerToolName: "delphi_run_playwright_flow", serverId: "delphi", serverLabel: "Delphi", toolName: "playwright" }
      ]
    });

    expect(instructions).toContain("isolated subagent tool loop");
    expect(instructions).toContain("Continue through the required execution tools");
    expect(instructions).toContain("never claim a listed execution tool or its result is unavailable merely because it was not called yet");
    expect(instructions).toContain('argumentsSchema: {"type":"object","additionalProperties":false,"required":["target"]');
    expect(instructions).toContain("MUST satisfy that tool's argumentsSchema exactly");
    expect(instructions).not.toContain("MEMORY OWNERSHIP");
    expect(instructions).not.toContain("GRAPH WORK DELEGATION");
    expect(instructions).not.toContain("archicode_update_memory");
  });

  it("sends the chatty response-style directive to Codex Local research when enabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-codex-research-style-"));
    const commandPath = path.join(root, "capture-codex-prompt.cjs");
    const promptPath = path.join(root, "prompt.txt");
    await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("fs");
const outIndex = process.argv.indexOf("--output-last-message");
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk.toString(); });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(promptPath)}, prompt, "utf8");
  if (outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], "Detailed answer.", "utf8");
  process.exit(0);
});
`, "utf8");
    await chmod(commandPath, 0o755);
    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "codex-local")!,
      localCommand: commandPath,
      model: "gpt-5.6-terra"
    };

    await expect(callResearchProvider(provider, "Explain the project", {
      projectRoot: root,
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      researchVerbosity: "chatty"
    })).resolves.toBe("Detailed answer.");

    const prompt = await readFile(promptPath, "utf8");
    expect(prompt).toContain("Per-turn response-style requirement: Important Research chat response style: be warm, welcoming, chatty & verbose in every response; never default to terse or short introverted answers.");
    expect(prompt).toContain("This applies to every chat message, including greetings, acknowledgements, straightforward questions, follow-ups, familiar topics, and complex research answers.");
    expect(prompt).toContain("Give complete, rich, inquisitive and useful responses and explanations");
    expect(prompt).toContain("Provide a detailed, conversational, and warm explanation.");
    expect(prompt).toContain("Expand on your reasoning and give examples for each point.");
    expect(prompt).toContain("This requirement overrides any general instruction to be concise.");
    expect(prompt).toContain("Never collapse a response into one or two sentences.");
    expect(prompt).not.toContain("Only be brief");
    expect(prompt).not.toContain("Unless the user asks for brevity");
    expect(prompt).not.toContain("Keep the visible answer conversational and concise.");
    expect(prompt.match(/Important Research chat response style/g)?.length).toBe(1);
    expect(prompt).toContain("Per-turn response-style requirement");
  });

  it("mounts approved project file MCP tools for Codex Local research exec runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-codex-research-files-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "App.tsx"), "export function App() {\n  return null;\n}\n", "utf8");
    const commandPath = path.join(root, "capture-codex-args.cjs");
    const argsPath = path.join(root, "args.json");
    await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("fs");
const outIndex = process.argv.indexOf("--output-last-message");
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)), "utf8");
process.stdin.resume();
process.stdin.on("end", () => {
  if (outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], "Captured args.", "utf8");
  process.exit(0);
});
`, "utf8");
    await chmod(commandPath, 0o755);
    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "codex-local")!,
      localCommand: commandPath
    };

    await expect(callResearchProvider(provider, "Can you read files?", {
      projectRoot: root,
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: []
    })).resolves.toBe("Captured args.");
    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    const joinedArgs = args.join("\n");

    expect(joinedArgs).toContain("archicode-project-files-mcp.mjs");
    expect(joinedArgs).toContain("mcp_servers.archicode-project-files.command=");
    expect(joinedArgs).toContain("mcp_servers.archicode-project-files.args=");
    expect(joinedArgs).toContain("mcp_servers.archicode-project-files.cwd=");
    expect(joinedArgs).toContain("mcp_servers.archicode-project-files.env.ELECTRON_RUN_AS_NODE=\"1\"");
    expect(joinedArgs).toContain("mcp_servers.archicode-project-files.default_tools_approval_mode=\"approve\"");

    const configIndex = args.findIndex((arg) => arg.includes("mcp_servers.archicode-project-files.args="));
    expect(configIndex).toBeGreaterThan(0);
    const mcpArgs = JSON.parse(args[configIndex].slice(args[configIndex].indexOf("=") + 1)) as string[];
    const serverPath = mcpArgs[0];
    expect(serverPath).toContain("archicode-project-files-mcp.mjs");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    });
    const client = new Client({ name: "archicode-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "archicode_project_list_files",
        "archicode_project_search_files",
        "archicode_project_read_file"
      ]));
      const listed = await client.callTool({ name: "archicode_project_list_files", arguments: { directory: "src" } });
      expect(JSON.stringify(listed)).toContain("src/App.tsx");
      const read = await client.callTool({ name: "archicode_project_read_file", arguments: { path: "src/App.tsx", startLine: 2, endLine: 2 } });
      expect(JSON.stringify(read)).toContain("return null");
      expect(JSON.stringify(read)).not.toContain("export function App");
    } finally {
      await client.close();
    }
  });

  it("resumes Codex Local research after an approval-required structured tool call", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-codex-research-approval-"));
    const commandPath = path.join(root, "codex-research-approval.cjs");
    await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("fs");
const outIndex = process.argv.indexOf("--output-last-message");
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk.toString(); });
process.stdin.on("end", () => {
  const message = stdin.includes("Tool result for mcp_context7_lookup_docs: resolved docs")
    ? "Final answer after approved tool result."
    : JSON.stringify({
        archicodeResearchTurn: {
          toolCalls: [
            {
              id: "lookup-1",
              providerToolName: "mcp_context7_lookup_docs",
              arguments: { query: "react router" }
            }
          ]
        }
      });
  if (outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], message, "utf8");
  process.exit(0);
});
`, "utf8");
    await chmod(commandPath, 0o755);
    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "codex-local")!,
      localCommand: commandPath
    };
    const approvalError = new Error("approval required");

    await expect(callResearchProvider(provider, "Need docs", {
      projectRoot: root,
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      mcpTools: [{
        providerToolName: "mcp_context7_lookup_docs",
        serverId: "context7",
        serverLabel: "Context7",
        toolName: "lookup_docs"
      }],
      callMcpTool: async () => {
        throw approvalError;
      },
      isApprovalError: (error) => error === approvalError
    })).rejects.toBe(approvalError);

    const continuation = (approvalError as Error & { providerContinuation?: { transport?: string; messages?: unknown[]; pendingToolCall?: { id: string; providerToolName: string; argumentsJson: string } } }).providerContinuation;
    expect(continuation?.transport).toBe("codex-local");
    expect(continuation?.pendingToolCall).toMatchObject({
      id: "lookup-1",
      providerToolName: "mcp_context7_lookup_docs"
    });
    if (!continuation || continuation.transport !== "codex-local" || !continuation.pendingToolCall) {
      throw new Error("Expected a codex-local provider continuation payload.");
    }
    const codexContinuation: ResearchProviderContinuation = {
      transport: "codex-local",
      messages: continuation.messages,
      pendingToolCall: continuation.pendingToolCall
    };

    await expect(callResearchProvider(provider, "Need docs", {
      projectRoot: root,
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      mcpTools: [{
        providerToolName: "mcp_context7_lookup_docs",
        serverId: "context7",
        serverLabel: "Context7",
        toolName: "lookup_docs"
      }],
      callMcpTool: async () => "resolved docs",
      resumeContinuation: { ...codexContinuation, approvedResult: "resolved docs" }
    })).resolves.toBe("Final answer after approved tool result.");
  });

  it("lets Claude Local research call terminal sink tools through the structured local tool loop", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-claude-research-sink-"));
    const commandPath = path.join(root, "claude-research-sink.cjs");
    await writeFile(commandPath, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    archicodeResearchTurn: {
      answer: "Prepared the graph proposal for review.",
      toolCalls: [
        {
          id: "change-set-1",
          providerToolName: "archicode_propose_graph_change_set",
          arguments: {
            summary: "Add one graph proposal.",
            operations: []
          }
        }
      ]
    }
  }));
  process.exit(0);
});
`, "utf8");
    await chmod(commandPath, 0o755);
    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "claude-local")!,
      localCommand: commandPath
    };
    const calls: string[] = [];

    await expect(callResearchProvider(provider, "Prepare a graph proposal", {
      projectRoot: root,
      webSearchEnabled: false,
      scopeContext: "{}",
      messages: [],
      researchStructuredToolsEnabled: true,
      mcpTools: [{
        providerToolName: "archicode_propose_graph_change_set",
        serverId: "archicode-research-internal",
        serverLabel: "Research",
        toolName: "propose_graph_change_set"
      }],
      isTerminalTool: (providerToolName) => providerToolName === "archicode_propose_graph_change_set",
      callMcpTool: async (input) => {
        calls.push(input.providerToolName);
        return "Graph change set captured for review.";
      }
    })).resolves.toBe("Prepared the graph proposal for review.");

    expect(calls).toEqual(["archicode_propose_graph_change_set"]);
  });

  it("tells read-only Codex Local coding runs to return complete source proposals for empty scaffolds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-codex-prompt-"));
    const commandPath = path.join(root, "capture-codex.cjs");
    const promptPath = path.join(root, "prompt.txt");
    await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("fs");
const outIndex = process.argv.indexOf("--output-last-message");
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(promptPath)}, stdin, "utf8");
  if (outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], "Captured prompt.", "utf8");
  process.exit(0);
});
`, "utf8");
    await chmod(commandPath, 0o755);

    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "codex-local")!,
      localCommand: commandPath,
      localSandbox: "read-only" as const
    };

    await callProvider(
      provider,
      JSON.stringify({
        projectConventions: { missingRecommended: ["package.json"] },
        detailedNodes: [{ title: "Vue/Vite Architecture", techStack: ["Vue 3", "Vite"] }]
      }),
      "Plan and code a blank app starter",
      { projectRoot: root, phase: "coding" }
    );

    const prompt = await readFile(promptPath, "utf8");
    expect(prompt).toContain("sandbox is read-only");
    expect(prompt).toContain("propose-source-file");
    expect(prompt).toContain("no app scaffold");
    expect(prompt).toContain("package.json");
    expect(prompt).toContain("complete file contents");
    expect(prompt).toContain("smallest self-contained runnable slice");
    expect(prompt).toContain("split it into smaller");
    expect(prompt).toContain("best-effort code-navigation hints");
    expect(prompt).toContain("never treat them as permissions");
  });

  it("pushes Codex Local planning runs to ask material clarification questions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-codex-plan-question-prompt-"));
    const commandPath = path.join(root, "capture-codex.cjs");
    const promptPath = path.join(root, "prompt.txt");
    await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("fs");
const outIndex = process.argv.indexOf("--output-last-message");
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(promptPath)}, stdin, "utf8");
  if (outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], "Captured prompt.", "utf8");
  process.exit(0);
});
`, "utf8");
    await chmod(commandPath, 0o755);

    const provider = {
      ...createSeedProject(root).project.settings.providers.find((item) => item.kind === "codex-local")!,
      localCommand: commandPath
    };

    await callProvider(
      provider,
      JSON.stringify({
        detailedNodes: [{ title: "Checkout", acceptanceCriteria: ["Users can pay"] }]
      }),
      "Plan an ambiguous checkout feature",
      { projectRoot: root, phase: "planning" }
    );

    const prompt = await readFile(promptPath, "utf8");
    expect(prompt).toContain("Decision: ask_questions");
    expect(prompt).toContain("Decision: proceed");
    expect(prompt).toContain("Goal, Approach, Key Assumptions, Implementation Steps, Verification, Risks");
    expect(prompt).toContain("target user/job");
    expect(prompt).toContain("llm-question");
    expect(prompt).toContain("stop without proposing code");
    expect(prompt).toContain("source implementation-agent");
    expect(prompt).toContain("Do not churn or expand hints speculatively");
  });

  it("injects the selected research personality into OpenAI and Anthropic research prompts", async () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!;
    const anthropicProvider = {
      ...provider,
      kind: "anthropic-compatible" as const,
      model: "claude-sonnet-4-6"
    };
    const personalityPrompt = researchPersonalityPrompt("claptrap");
    const options = {
      scopeContext: "{\"scope\":\"project\"}",
      sessionSummary: "Existing summary",
      researchMemory: "Remember this",
      researchOrchestration: "Do the next thing",
      researchPersonalityPrompt: personalityPrompt,
      messages: [],
      selectedSkillsPrompt: "Selected skills prompt.",
      webSearchEnabled: true
    };

    const responsesBody = await buildOpenAIResearchResponsesBody(provider, "Hello", options, defaultPhaseModelPolicies.brainstorming);
    const chatBody = await buildOpenAIResearchChatCompletionsBody(provider, "Hello", options, defaultPhaseModelPolicies.brainstorming);
    const anthropicBody = await buildAnthropicResearchBody(anthropicProvider, "Hello", options, defaultPhaseModelPolicies.brainstorming);

    expect(JSON.stringify(responsesBody)).toContain("Claptrap from Borderlands");
    expect(JSON.stringify(responsesBody)).toContain("Adopt the selected personality fully in how you speak and present yourself.");
    expect(JSON.stringify(responsesBody)).toContain("Avoid flat openings like 'Hello, I'm Archi'");
    expect(JSON.stringify(responsesBody)).toContain("Do not start in character and then fall back to a neutral generic assistant voice");
    expect(JSON.stringify(chatBody)).toContain("Claptrap from Borderlands");
    expect(JSON.stringify(anthropicBody)).toContain("Claptrap from Borderlands");
  });

  it("gates complete research chat answers behind the chatty verbosity setting without changing build prompts", async () => {
    const provider = {
      ...createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!,
      model: "gpt-5.6-terra"
    };
    const policy = { ...defaultPhaseModelPolicies.brainstorming, modelOverride: "gpt-5.6-luna" };
    const options = {
      scopeContext: "{}",
      webSearchEnabled: false,
      messages: [],
      researchVerbosity: "chatty" as const
    };

    expect(researchResponseStyleDirective("default")).toBe("");
    expect(researchResponseStyleDirective("chatty")).toContain("warm, welcoming, chatty & verbose");
    expect(researchResponseStyleDirective("chatty")).toContain("every chat message");
    expect(researchResponseStyleDirective("chatty")).not.toContain("asks for brevity");
    expect(researchResponseStyleDirective("chatty")).not.toContain("GPT-5.6");

    const responsesBody = await buildOpenAIResearchResponsesBody(provider, "Explain this", options, policy);
    const chatBody = await buildOpenAIResearchChatCompletionsBody(provider, "Explain this", options, policy);

    expect(String(responsesBody.instructions)).toContain("Important Research chat response style");
    expect(String((chatBody.messages as Array<{ content: string }>)[0]?.content)).toContain("Important Research chat response style");
    expect(String(responsesBody.instructions)).toContain("Provide a detailed, conversational, and warm explanation.");
    expect(String((chatBody.messages as Array<{ content: string }>)[0]?.content)).toContain("Expand on your reasoning and give examples for each point.");
    expect(String(responsesBody.instructions)).not.toContain("Keep the visible answer conversational and concise.");
    expect(String((chatBody.messages as Array<{ content: string }>)[0]?.content)).not.toContain("Keep the visible answer conversational and concise.");
    expect(JSON.stringify(responsesBody)).toContain("Per-turn response-style requirement");
    expect(JSON.stringify(chatBody)).toContain("Per-turn response-style requirement");
    expect(JSON.stringify(responsesBody).match(/Important Research chat response style/g)?.length).toBe(1);
    expect(JSON.stringify(chatBody).match(/Important Research chat response style/g)?.length).toBe(1);
    expect(responsesBody.model).toBe("gpt-5.6-luna");
    expect(chatBody.model).toBe("gpt-5.6-luna");

    const buildBody = buildOpenAICompatibleBody(provider, "{}", "Implement this efficiently", false, "coding", policy);
    expect(JSON.stringify(buildBody)).not.toContain("Provide a detailed, conversational, and warm explanation.");
    expect(JSON.stringify(buildBody)).not.toContain("Expand on your reasoning and give examples for each point.");

    const otherModelBody = await buildOpenAIResearchResponsesBody(
      { ...provider, model: "gpt-5.5" },
      "Explain this",
      { ...options, researchVerbosity: "default" },
      defaultPhaseModelPolicies.brainstorming
    );
    expect(String(otherModelBody.instructions)).not.toContain("Important Research chat response style");
    expect(String(otherModelBody.instructions)).toContain("Keep the visible answer conversational and concise.");
  });

  it("builds real multi-turn research threads with a cacheable stable prefix", async () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "openai-compatible")!;
    const anthropicProvider = { ...provider, kind: "anthropic-compatible" as const, model: "claude-sonnet-4-6" };
    const makeMessage = (role: "user" | "assistant", content: string): ResearchChatMessage => ({
      id: `msg-${role}-${content.length}`,
      role,
      content,
      createdAt: new Date().toISOString(),
      attachmentIds: [],
      webUsed: false,
      mcpToolCalls: [],
      subagentRuns: []
    });
    const options = {
      scopeContext: "{\"scope\":\"project\"}",
      sessionSummary: "Existing summary",
      researchMemory: "VOLATILE_MEMORY_MARKER",
      selectedSkillsPrompt: "STABLE_SKILLS_MARKER",
      webSearchEnabled: false,
      // The current user message is also the trailing history entry (as in real turns).
      messages: [makeMessage("user", "first question"), makeMessage("assistant", "first answer"), makeMessage("user", "Hello")]
    };

    const anthropicBody = await buildAnthropicResearchBody(anthropicProvider, "Hello", options, defaultPhaseModelPolicies.brainstorming);
    const systemBlocks = anthropicBody.system as Array<Record<string, unknown>>;
    expect(Array.isArray(systemBlocks)).toBe(true);
    const cachedBlock = systemBlocks.find((block) => block.cache_control);
    // The large, slow-changing scope/skills sit in the cached prefix...
    expect(cachedBlock?.cache_control).toEqual({ type: "ephemeral" });
    expect(String(cachedBlock?.text)).toContain("STABLE_SKILLS_MARKER");
    expect(String(cachedBlock?.text)).toContain("\"scope\":\"project\"");
    // ...while volatile per-turn memory must NOT bust the cache.
    expect(JSON.stringify(systemBlocks)).not.toContain("VOLATILE_MEMORY_MARKER");

    const messages = anthropicBody.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]).toEqual({ role: "user", content: "first question" });
    expect(messages[1]).toEqual({ role: "assistant", content: "first answer" });
    // The current user turn carries the volatile context and the user message,
    // and the trailing duplicate "Hello" history entry is not repeated as a turn.
    const lastTurn = JSON.stringify(messages[messages.length - 1]);
    expect(messages[messages.length - 1]?.role).toBe("user");
    expect(lastTurn).toContain("VOLATILE_MEMORY_MARKER");
    expect(lastTurn).toContain("User message: Hello");
    expect(messages.filter((message) => JSON.stringify(message.content).includes("User message: Hello"))).toHaveLength(1);

    // Responses: persisted assistant text must use the easy-input string form.
    // output_text arrays are only valid on complete provider output items with
    // their original id/status/type and break strict compatible providers.
    const responsesBody = await buildOpenAIResearchResponsesBody(provider, "Hello", options, defaultPhaseModelPolicies.brainstorming);
    const responseInput = responsesBody.input as Array<{ role: string; content: unknown }>;
    expect(responseInput[0]).toEqual({
      role: "user",
      content: [{ type: "input_text", text: "first question" }]
    });
    expect(responseInput[1]).toEqual({ role: "assistant", content: "first answer" });
    expect(responseInput[responseInput.length - 1]?.role).toBe("user");
    expect(JSON.stringify(responseInput[responseInput.length - 1]?.content)).toContain("User message: Hello");
    expect(JSON.stringify(responseInput)).not.toContain("output_text");

    // Chat Completions: stable content stays in the leading system message.
    const chatBody = await buildOpenAIResearchChatCompletionsBody(provider, "Hello", options, defaultPhaseModelPolicies.brainstorming);
    const chatMessages = chatBody.messages as Array<{ role: string; content: string }>;
    expect(chatMessages[0]?.role).toBe("system");
    expect(chatMessages[0]?.content).toContain("STABLE_SKILLS_MARKER");
    expect(chatMessages[0]?.content).not.toContain("VOLATILE_MEMORY_MARKER");
    expect(chatMessages.some((message) => message.role === "assistant" && message.content === "first answer")).toBe(true);
    expect(chatMessages[chatMessages.length - 1]?.role).toBe("user");
    expect(chatMessages[chatMessages.length - 1]?.content).toContain("VOLATILE_MEMORY_MARKER");
  });
});
