import { describe, expect, it } from "vitest";
import { runAgentLoop, type AgentProviderTurn, type AgentToolResult } from "../src/main/agentRuntime";

describe("shared agent runtime", () => {
  it("lets the agent choose and execute an arbitrary tool trajectory until it returns a terminal answer", async () => {
    const turns: AgentProviderTurn<string>[] = [
      { text: "", raw: "inspect", toolCalls: [{ id: "1", providerToolName: "inspect", argumentsJson: "{}" }] },
      { text: "", raw: "read", toolCalls: [{ id: "2", providerToolName: "read", argumentsJson: "{\"path\":\"src/app.ts\"}" }] },
      { text: "Finished from evidence.", raw: "done", toolCalls: [] }
    ];
    const committed: AgentToolResult[][] = [];
    const executed: string[] = [];

    const result = await runAgentLoop({
      adapter: {
        nextTurn: async () => turns.shift()!,
        commitToolResults: (_turn, toolResults) => { committed.push(toolResults); }
      },
      executeTool: async (toolCall) => {
        executed.push(toolCall.providerToolName);
        return `${toolCall.providerToolName} result`;
      }
    });

    expect(result).toBe("Finished from evidence.");
    expect(executed).toEqual(["inspect", "read"]);
    expect(committed.flat().map((entry) => entry.result)).toEqual(["inspect result", "read result"]);
  });

  it("pauses on approval and lets the adapter persist the exact pending call", async () => {
    const approval = new Error("approval required");
    let captured: string | undefined;

    await expect(runAgentLoop({
      adapter: {
        nextTurn: async () => ({
          text: "",
          raw: "approval-turn",
          toolCalls: [{ id: "approve-1", providerToolName: "install", argumentsJson: "{\"name\":\"playwright\"}" }]
        }),
        commitToolResults: () => {},
        attachApprovalContinuation: ({ pendingToolCall }) => { captured = pendingToolCall.id; }
      },
      executeTool: async () => { throw approval; },
      isApprovalError: (error) => error === approval
    })).rejects.toBe(approval);

    expect(captured).toBe("approve-1");
  });

  it("executes a tool batch in order and stops at the first approval boundary", async () => {
    const approval = new Error("approval required");
    const executed: string[] = [];
    let completedBeforePause: string[] = [];

    await expect(runAgentLoop({
      adapter: {
        nextTurn: async () => ({
          text: "",
          raw: "ordered-batch",
          toolCalls: [
            { id: "write-1", providerToolName: "write", argumentsJson: "{}" },
            { id: "approve-2", providerToolName: "install", argumentsJson: "{}" },
            { id: "finish-3", providerToolName: "finish", argumentsJson: "{}" }
          ]
        }),
        commitToolResults: () => {},
        attachApprovalContinuation: ({ completedResults }) => {
          completedBeforePause = completedResults.map((entry) => entry.toolCall.id);
        }
      },
      executeTool: async (toolCall) => {
        executed.push(toolCall.id);
        if (toolCall.id === "approve-2") throw approval;
        return "ok";
      },
      isApprovalError: (error) => error === approval
    })).rejects.toBe(approval);

    expect(executed).toEqual(["write-1", "approve-2"]);
    expect(completedBeforePause).toEqual(["write-1"]);
  });

  it("asks the adapter for one visible answer after a terminal sink that returned no prose", async () => {
    const turns: AgentProviderTurn<string>[] = [
      { text: "", raw: "sink", toolCalls: [{ id: "sink-1", providerToolName: "submit", argumentsJson: "{}" }] },
      { text: "Prepared for review.", raw: "answer", toolCalls: [] }
    ];
    let requestedFinal = false;

    await expect(runAgentLoop({
      adapter: {
        nextTurn: async () => turns.shift()!,
        commitToolResults: () => {},
        requestFinalAnswer: () => { requestedFinal = true; }
      },
      executeTool: async () => "captured",
      completionAfterTools: () => ({ complete: true, requireVisibleAnswer: true })
    })).resolves.toBe("Prepared for review.");

    expect(requestedFinal).toBe(true);
  });

  it("applies caller-owned terminal sink semantics without provider-specific loop logic", async () => {
    let turnCount = 0;

    await expect(runAgentLoop({
      adapter: {
        nextTurn: async () => {
          turnCount += 1;
          return {
            text: "The requested graph update is ready for review.",
            raw: "sink",
            toolCalls: [{ id: "sink-1", providerToolName: "submit_graph", argumentsJson: "{}" }]
          };
        },
        commitToolResults: () => {}
      },
      executeTool: async () => "captured",
      isTerminalTool: (name) => name === "submit_graph",
      terminalToolCompletesTurn: (name) => name === "submit_graph"
    })).resolves.toBe("The requested graph update is ready for review.");

    expect(turnCount).toBe(1);
  });

  it("retries a transient transport failure inside the same trajectory", async () => {
    let attempts = 0;
    let retries = 0;

    await expect(runAgentLoop({
      adapter: {
        nextTurn: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("socket hang up");
          return { text: "Recovered without restarting.", raw: "answer", toolCalls: [] };
        },
        commitToolResults: () => {}
      },
      onTransientRetry: () => { retries += 1; }
    })).resolves.toBe("Recovered without restarting.");

    expect(attempts).toBe(2);
    expect(retries).toBe(1);
  });

  it("feeds contract rejection into the same transcript until the agent returns a valid answer", async () => {
    const turns: AgentProviderTurn<string>[] = [
      { text: "incomplete", raw: "first", toolCalls: [] },
      { text: "evidence-backed", raw: "second", toolCalls: [] }
    ];
    const feedback: string[] = [];

    await expect(runAgentLoop({
      adapter: {
        nextTurn: async () => turns.shift()!,
        commitToolResults: () => {},
        commitInvalidAnswer: (_turn, message) => { feedback.push(message); }
      },
      validateFinalAnswer: (text) => text === "evidence-backed" ? undefined : "Missing evidence."
    })).resolves.toBe("evidence-backed");

    expect(feedback).toEqual(["Missing evidence."]);
  });

  it("stops an agent that repeats the same rejected final answer without changing trajectory", async () => {
    const feedback: string[] = [];

    await expect(runAgentLoop({
      adapter: {
        nextTurn: async () => ({ text: "I still need to update memory.", raw: "repeat", toolCalls: [] }),
        commitToolResults: () => {},
        commitInvalidAnswer: (_turn, message) => { feedback.push(message); }
      },
      validateFinalAnswer: () => "Return the evidence-backed user report; the host owns memory."
    })).rejects.toThrow("Consecutive identical invalid final-answer loop detected; stopped on attempt 3");

    expect(feedback).toHaveLength(2);
    expect(feedback[1]).toContain("this final answer is identical");
  });

  it("stops rephrased answers that keep failing the same contract without new tool evidence", async () => {
    const answers = [
      "The responsive layout could not be verified.",
      "Responsive coverage remains incomplete.",
      "I cannot confirm the responsive presentation."
    ];
    let turnCount = 0;

    await expect(runAgentLoop({
      adapter: {
        nextTurn: async () => ({ text: answers[turnCount++]!, raw: `answer-${turnCount}`, toolCalls: [] }),
        commitToolResults: () => {},
        commitInvalidAnswer: () => {}
      },
      validateFinalAnswer: (answer) => `A requested screenshot was not model-inspected.\n\nPrevious response: ${answer}`
    })).rejects.toThrow("Repeated final-answer validation loop detected for the same contract failure with no new tool evidence; stopped on attempt 3");

    expect(turnCount).toBe(3);
  });

  it("validates a captured terminal sink result before accepting it", async () => {
    const turns: AgentProviderTurn<string>[] = [
      { text: "", raw: "bad-submit", toolCalls: [{ id: "1", providerToolName: "submit", argumentsJson: "{}" }] },
      { text: "corrected", raw: "answer", toolCalls: [] }
    ];
    const feedback: string[] = [];

    await expect(runAgentLoop({
      adapter: {
        nextTurn: async () => turns.shift()!,
        commitToolResults: () => {},
        commitFeedback: (message) => { feedback.push(message); }
      },
      executeTool: async () => "captured",
      completionAfterTools: () => ({ complete: true, fallbackText: "captured" }),
      validateFinalAnswer: (text) => text === "corrected" ? undefined : "Captured result was incomplete."
    })).resolves.toBe("corrected");

    expect(feedback).toEqual(["Captured result was incomplete."]);
  });
});
