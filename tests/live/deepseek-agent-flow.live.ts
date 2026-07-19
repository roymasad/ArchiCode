import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProviderMcpTool } from "../../src/main/mcp";
import {
  callResearchProvider,
  type ResearchProviderContinuation,
  type ResearchProviderOptions
} from "../../src/main/providers";
import { providerSettingsSchema, type ProjectSettings } from "../../src/shared/schema";

const LIVE_REQUEST_LIMIT = 14;
const LIVE_CALL_TIMEOUT_MS = 75_000;
const deepSeekKey = process.env.DEEPSEEK_KEY?.trim();
const deepSeekModel = process.env.DEEPSEEK_MODEL?.trim();
const deepSeekBaseUrl = process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com/v1";
const liveCredentialsAvailable = Boolean(deepSeekKey && deepSeekModel);

let originalFetch: typeof globalThis.fetch;
let liveRequestCount = 0;

function deepSeekProvider(): ProjectSettings["providers"][number] {
  const provider = providerSettingsSchema.parse({
    id: "deepseek-live",
    kind: "openai-compatible",
    label: "DeepSeek live integration",
    baseUrl: deepSeekBaseUrl,
    model: deepSeekModel,
    apiKeyEnv: "DEEPSEEK_KEY",
    openAiEndpointMode: "chat-completions",
    enabled: true
  });
  return {
    ...provider,
    phaseModelPolicies: {
      ...provider.phaseModelPolicies,
      brainstorming: {
        ...provider.phaseModelPolicies.brainstorming,
        temperature: 0,
        reasoningMode: "off",
        maxOutputTokens: 900
      }
    }
  };
}

function liveOptions(overrides: Partial<ResearchProviderOptions> = {}): ResearchProviderOptions {
  return {
    webSearchEnabled: false,
    scopeContext: "Live integration sandbox. Only the explicitly advertised in-memory test tools are available; no project or shell mutation is permitted.",
    messages: [],
    signal: AbortSignal.timeout(LIVE_CALL_TIMEOUT_MS),
    ...overrides
  };
}

function liveTool(input: {
  name: string;
  description: string;
  properties?: Record<string, unknown>;
  required?: string[];
}): ProviderMcpTool {
  return {
    providerToolName: input.name,
    serverId: "archicode-live-integration",
    serverLabel: "Live integration",
    toolName: input.name,
    description: input.description,
    inputSchema: {
      type: "object",
      properties: input.properties ?? {},
      required: input.required ?? []
    }
  };
}

const evidenceTool = liveTool({
  name: "live_read_runtime_evidence",
  description: "Read deterministic evidence for the live shared-runtime integration check.",
  properties: { subject: { type: "string" } },
  required: ["subject"]
});

const approvalTool = liveTool({
  name: "live_approval_action",
  description: "Perform the harmless action that the live test deliberately places behind an approval boundary.",
  properties: { action: { type: "string" } },
  required: ["action"]
});

const workerEvidenceTool = liveTool({
  name: "live_worker_evidence",
  description: "Return the deterministic evidence that the delegated worker needs to finish its bounded objective. Do not guess this evidence.",
  properties: { objective: { type: "string" } },
  required: ["objective"]
});

const delegateTool = liveTool({
  name: "live_delegate_worker",
  description: "Delegate the bounded evidence investigation to an independent worker and return its completed report.",
  properties: { objective: { type: "string" } },
  required: ["objective"]
});

describe.skipIf(!liveCredentialsAvailable)("DeepSeek live shared-agent flow", () => {
  beforeAll(() => {
    originalFetch = globalThis.fetch;
    const networkFetch = originalFetch.bind(globalThis);
    globalThis.fetch = async (input, init) => {
      liveRequestCount += 1;
      if (liveRequestCount > LIVE_REQUEST_LIMIT) {
        throw new Error(`Live DeepSeek request ceiling exceeded (${LIVE_REQUEST_LIMIT}).`);
      }
      return networkFetch(input, init);
    };
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses a real tool loop and repairs a rejected final answer in the same trajectory", async () => {
    const toolCalls: string[] = [];
    let finalValidationCount = 0;

    const answer = await callResearchProvider(
      deepSeekProvider(),
      [
        "Run the live shared-runtime check.",
        "Call live_read_runtime_evidence exactly once with subject shared-agent-runtime; do not invent its result.",
        "Then answer concisely using the returned evidence."
      ].join("\n"),
      liveOptions({
        mcpTools: [evidenceTool],
        callMcpTool: async ({ providerToolName, argumentsJson }) => {
          toolCalls.push(providerToolName);
          expect(providerToolName).toBe(evidenceTool.providerToolName);
          expect(JSON.parse(argumentsJson)).toMatchObject({ subject: "shared-agent-runtime" });
          return JSON.stringify({ value: 17, evidenceToken: "LIVE_EVIDENCE_314159" });
        },
        validateFinalAnswer: (text) => {
          finalValidationCount += 1;
          if (finalValidationCount === 1) {
            return "LIVE CONTRACT CORRECTION: Keep the evidence-backed answer, but add the exact marker CONTRACT_REPAIRED. Continue this same trajectory; do not repeat the tool call.";
          }
          if (!text.includes("CONTRACT_REPAIRED")) return "The required marker CONTRACT_REPAIRED is still missing.";
          if (!text.includes("LIVE_EVIDENCE_314159") || !text.includes("17")) return "Preserve the exact evidence token and value returned by the tool.";
          return undefined;
        }
      })
    );

    expect(toolCalls).toEqual([evidenceTool.providerToolName]);
    expect(finalValidationCount).toBe(2);
    expect(answer).toContain("LIVE_EVIDENCE_314159");
    expect(answer).toContain("17");
    expect(answer).toContain("CONTRACT_REPAIRED");
  });

  it("pauses at approval and resumes from the exact pending tool call", async () => {
    const approvalError = new Error("live approval required");
    const provider = deepSeekProvider();
    const prompt = "Call live_approval_action exactly once with action confirm-live-resume. After approval, report the returned approval token.";

    await expect(callResearchProvider(provider, prompt, liveOptions({
      mcpTools: [approvalTool],
      callMcpTool: async () => { throw approvalError; },
      isApprovalError: (error) => error === approvalError
    }))).rejects.toBe(approvalError);

    const continuation = (approvalError as Error & { providerContinuation?: ResearchProviderContinuation }).providerContinuation;
    expect(continuation?.transport).toBe("openai-chat");
    expect(continuation?.pendingToolCall.providerToolName).toBe(approvalTool.providerToolName);
    if (!continuation) throw new Error("The live approval pause did not preserve its provider continuation.");

    let unexpectedReplay = false;
    const answer = await callResearchProvider(provider, prompt, liveOptions({
      mcpTools: [approvalTool],
      callMcpTool: async () => {
        unexpectedReplay = true;
        return "unexpected replay";
      },
      resumeContinuation: {
        ...continuation,
        approvedResult: JSON.stringify({ approved: true, approvalToken: "APPROVED_2718" })
      }
    }));

    expect(unexpectedReplay).toBe(false);
    expect(answer).toContain("APPROVED_2718");
  });

  it("lets a parent delegate to an autonomous worker and synthesize its contract result", async () => {
    const provider = deepSeekProvider();
    let delegateCalls = 0;
    let workerEvidenceCalls = 0;

    const answer = await callResearchProvider(
      provider,
      "Delegate the bounded runtime-evidence investigation through live_delegate_worker, then synthesize its evidence token and conclusion. Do not perform the worker's investigation yourself.",
      liveOptions({
        mcpTools: [delegateTool],
        callMcpTool: async ({ providerToolName, argumentsJson }) => {
          expect(providerToolName).toBe(delegateTool.providerToolName);
          delegateCalls += 1;
          const objective = String((JSON.parse(argumentsJson) as { objective?: unknown }).objective ?? "");
          const workerAnswer = await callResearchProvider(
            provider,
            objective || "Collect the delegated runtime evidence.",
            liveOptions({
              systemInstructionsOverride: [
                "You are an independent bounded integration-test worker.",
                "Choose your own useful trajectory, but you must obtain evidence through live_worker_evidence before concluding.",
                "Return a concise report containing the exact evidence token and a pass/fail conclusion."
              ].join("\n"),
              mcpTools: [workerEvidenceTool],
              callMcpTool: async ({ providerToolName: workerToolName }) => {
                expect(workerToolName).toBe(workerEvidenceTool.providerToolName);
                workerEvidenceCalls += 1;
                return JSON.stringify({ evidenceToken: "WORKER_EVIDENCE_1618", conclusion: "pass" });
              },
              validateFinalAnswer: (text) => {
                if (workerEvidenceCalls < 1) return "Obtain evidence with live_worker_evidence before returning the worker report.";
                if (!text.includes("WORKER_EVIDENCE_1618")) return "Include the exact evidence token returned by the worker tool.";
                return undefined;
              }
            })
          );
          return workerAnswer;
        },
        validateFinalAnswer: (text) => {
          if (delegateCalls < 1) return "Delegate this objective with live_delegate_worker before synthesizing the result.";
          if (!text.includes("WORKER_EVIDENCE_1618")) return "Include the delegated worker's exact evidence token in the parent synthesis.";
          return undefined;
        }
      })
    );

    expect(delegateCalls).toBe(1);
    // The worker owns its tactics. The contract requires real evidence, not a
    // host-prescribed number of read-only evidence calls.
    expect(workerEvidenceCalls).toBeGreaterThanOrEqual(1);
    expect(answer).toContain("WORKER_EVIDENCE_1618");
  });
});
