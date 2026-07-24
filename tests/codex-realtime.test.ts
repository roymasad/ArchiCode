import { describe, expect, it, vi } from "vitest";
import { createCodexRealtimeClientSecret } from "../src/main/codexRealtime";
import { buildBriefingCuratorRealtimePrompt, buildResearchRealtimePrompt } from "../src/main/research/realtimePrompt";
import { OpenAiRealtimeCall, OpenAiRealtimeEventBridge } from "../src/renderer/src/components/researchRealtime";
import { deriveResearchChatContextPlanForModel } from "../src/shared/contextBudget";
import { researchChatMessageSchema } from "../src/shared/schema";
import { projectBriefingSchema, projectBriefingVoiceCommands } from "../src/shared/projectBriefing";

function message(index: number, role: "user" | "assistant", content: string) {
  return researchChatMessageSchema.parse({
    id: `message-${index}`,
    role,
    content,
    createdAt: new Date(2026, 0, 1, 0, index).toISOString()
  });
}

describe("OpenAI Realtime Research context", () => {
  const contextPlan = deriveResearchChatContextPlanForModel("gpt-realtime-2.1");

  it("seeds the selected chat identity, project context, memory, and recent transcript", () => {
    const prompt = buildResearchRealtimePrompt({
      compactContext: JSON.stringify({ project: { name: "Voice Project" }, selectedNode: "Checkout" }),
      contextPlan,
      personalityPrompt: "Use the configured Archi personality.",
      researchVerbosity: "default",
      session: {
        title: "Checkout research",
        scope: { type: "project", projectId: "project-voice" },
        summary: "The user chose Stripe for checkout.",
        memory: { decisions: ["Keep guest checkout"] },
        messages: [
          message(1, "user", "We should keep guest checkout."),
          message(2, "assistant", "Agreed. I will remember that constraint.")
        ]
      }
    });

    expect(prompt).toContain("You are Archi");
    expect(prompt).toContain("ACTIVE PERSONALITY - HIGH PRIORITY FOR EVERY SPOKEN TURN:");
    expect(prompt).toContain("Perform the selected personality directly and unmistakably in every response");
    expect(prompt.indexOf("Use the configured Archi personality.")).toBeLessThan(prompt.indexOf("The user must experience one coherent Archi"));
    expect(prompt).toContain("Voice Project");
    expect(prompt).toContain("The user chose Stripe for checkout.");
    expect(prompt).toContain("Keep guest checkout");
    expect(prompt).toContain("User: We should keep guest checkout.");
    expect(prompt).toContain("Archi: Agreed. I will remember that constraint.");
    expect(prompt).toContain("delegate with deliverable graph-review");
    expect(prompt).toContain("spoken approval");
    expect(prompt).toContain("explicitly name what needs approval");
    expect(prompt).toContain("'Run App' or a 'runtime target'");
    expect(prompt).toContain("'I want to test it myself' means launch Run App");
    expect(prompt).toContain("Do not ask for clarification in those cases");
    expect(prompt).toContain("archicode_launch_run_app");
    expect(prompt).toContain("archicode_stop_run_app");
    expect(prompt).toContain("archicode_restart_run_app");
    expect(prompt).toContain("archicode_queue_implementation");
    expect(prompt).toContain("archicode_run_verification");
    expect(prompt).toContain("directly control configured runtime services");
    expect(prompt).toContain("do not delegate to Research, create an approval card, or queue an Activity run");
    expect(prompt).toContain("archicode_cancel_research_task");
    expect(prompt).toContain("archicode_read_chat_history");
    expect(prompt).toContain("archicode_search_previous_chats");
    expect(prompt).toContain("archicode_run_guarded_command");
    expect(prompt).toContain("archicode_search_web");
    expect(prompt).toContain("Never tell the user these capabilities are unavailable");
  });

  it("keeps reconnect handoffs bounded while retaining the newest turns", () => {
    const messages = Array.from({ length: contextPlan.recentMessageLimit + 5 }, (_, index) =>
      message(index, index % 2 ? "assistant" : "user", `turn-${index}`)
    );
    const prompt = buildResearchRealtimePrompt({
      compactContext: "{}",
      contextPlan,
      session: {
        title: "Long chat",
        scope: { type: "project", projectId: "project-voice" },
        messages
      }
    });

    expect(prompt).toContain("Earlier transcript entries are represented");
    expect(prompt).not.toContain("turn-0");
    expect(prompt).toContain(`turn-${messages.length - 1}`);
  });

  it("gives Atlas complete briefing and project awareness without narration or action authority", () => {
    const briefing = projectBriefingSchema.parse({
      id: "briefing-atlas",
      projectId: "project-voice",
      preset: "quick",
      locale: "en",
      title: "Project in five cards",
      subtitle: "A useful orientation",
      generatedAt: "2026-07-24T10:00:00.000Z",
      voice: projectBriefingVoiceCommands,
      slides: Array.from({ length: 5 }, (_, index) => ({
        id: `slide-${index + 1}`,
        kicker: `Part ${index + 1}`,
        title: `Slide ${index + 1}`,
        body: `Grounded explanation ${index + 1}`,
        narration: `Natural narration ${index + 1}`,
        visual: {
          kind: "spotlight",
          items: [{ id: "system", label: "System", kind: "system", tone: "cyan" }],
          connections: []
        },
        evidence: [{ reference: "project:project-voice", label: "Project", excerpt: "Grounded project fact." }],
        suggestedQuestions: []
      }))
    });
    const prompt = buildBriefingCuratorRealtimePrompt({
      briefing,
      compactContext: JSON.stringify({ project: { name: "Voice Project" }, graph: { flows: ["Checkout"] } }),
      contextPlan,
      history: [{ question: "Who uses it?", answer: "Operators use it." }],
      languageInstruction: "Write all user-facing content in English.",
      session: {
        title: "Atlas · Project in five cards",
        scope: { type: "project", projectId: "project-voice" },
        messages: [message(1, "assistant", "Welcome to the briefing.")]
      },
      slideIndex: 2
    });

    expect(prompt).toContain("You are Atlas");
    expect(prompt).toContain("distinct from Archi");
    expect(prompt).toContain("exactly one concise opening of two or three natural sentences");
    expect(prompt).toContain("name the project briefing that is open");
    expect(prompt).toContain("what this presentation will help the user understand");
    expect(prompt).toContain("Every newly opened briefing is a fresh orientation");
    expect(prompt).toContain("Never infer that the user is already aligned");
    expect(prompt).toContain("Do not narrate slide changes");
    expect(prompt).toContain("strictly read-only");
    expect(prompt).toContain("archicode_read_research_context");
    expect(prompt).toContain("AUTHORITATIVE CURRENT BRIEFING VIEW");
    expect(prompt).toContain("always wins");
    expect(prompt).toContain("Voice Project");
    expect(prompt).toContain("Slide 5");
    expect(prompt).toContain("Slide 3");
    expect(prompt).toContain("Operators use it.");
    expect(prompt).toContain("Atlas: Welcome to the briefing.");
    expect(prompt).not.toContain("Archi: Welcome to the briefing.");
  });
});

describe("OpenAI Realtime session tools", () => {
  it("exposes live activity monitoring alongside Research delegation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      value: "ephemeral-secret",
      expires_at: 1_800_000_000,
      session: { id: "session-1", model: "gpt-realtime-2.1" }
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await createCodexRealtimeClientSecret({
        apiKey: "test-key",
        model: "gpt-realtime-2.1",
        prompt: "You are Archi.",
        projectRoot: "/tmp/project",
        voice: "marin"
      });
      const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const body = JSON.parse(String(request.body)) as {
        session?: {
          audio?: { input?: { turn_detection?: { create_response?: boolean; interrupt_response?: boolean } } };
          tools?: Array<{
            name?: string;
            parameters?: {
              properties?: { deliverable?: { enum?: string[] }; profileId?: unknown; serviceId?: unknown; targetId?: unknown };
              required?: string[];
            };
          }>;
        };
      };
      expect(body.session?.audio?.input?.turn_detection).toMatchObject({
        create_response: false,
        interrupt_response: true
      });
      expect(body.session?.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "archicode_start_research_task",
        "archicode_launch_run_app",
        "archicode_stop_run_app",
        "archicode_restart_run_app",
        "archicode_queue_implementation",
        "archicode_run_verification",
        "archicode_get_research_task_status",
        "archicode_cancel_research_task",
        "archicode_refresh_project_context",
        "archicode_get_live_activity",
        "archicode_read_chat_history",
        "archicode_search_previous_chats",
        "archicode_project_list_files",
        "archicode_project_search_files",
        "archicode_project_read_file",
        "archicode_run_guarded_command",
        "archicode_search_web"
      ]));
      const taskTool = body.session?.tools?.find((tool) => tool.name === "archicode_start_research_task");
      expect(taskTool?.parameters?.required).toEqual(["task", "deliverable"]);
      expect(taskTool?.parameters?.properties?.deliverable?.enum).toEqual([
        "answer",
        "graph-review",
        "project-action"
      ]);
      const runAppTool = body.session?.tools?.find((tool) => tool.name === "archicode_launch_run_app");
      expect(runAppTool?.parameters?.required).toEqual(["profileId"]);
      expect(runAppTool?.parameters?.properties).toHaveProperty("profileId");
      expect(runAppTool?.parameters?.properties).toHaveProperty("targetId");
      expect(runAppTool?.parameters?.properties).not.toHaveProperty("task");
      for (const toolName of ["archicode_stop_run_app", "archicode_restart_run_app"]) {
        const lifecycleTool = body.session?.tools?.find((tool) => tool.name === toolName);
        expect(lifecycleTool?.parameters?.required).toEqual(["serviceId"]);
        expect(lifecycleTool?.parameters?.properties).toHaveProperty("serviceId");
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("limits Atlas briefing sessions to read-only context and inspection tools", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      value: "ephemeral-secret",
      expires_at: 1_800_000_000,
      session: { id: "atlas-session", model: "gpt-realtime-2.1" }
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await createCodexRealtimeClientSecret({
        apiKey: "test-key",
        model: "gpt-realtime-2.1",
        prompt: "You are Atlas.",
        projectRoot: "/tmp/project",
        surface: "briefing-curator",
        voice: "marin"
      });
      const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const body = JSON.parse(String(request.body)) as {
        session?: { tools?: Array<{ name?: string }> };
      };
      const names = body.session?.tools?.map((tool) => tool.name) ?? [];
      expect(names).toEqual([
        "archicode_refresh_project_context",
        "archicode_read_research_context",
        "archicode_read_chat_history",
        "archicode_search_previous_chats",
        "archicode_project_list_files",
        "archicode_project_search_files",
        "archicode_project_read_file",
        "archicode_project_query_code_graph"
      ]);
      expect(names).not.toEqual(expect.arrayContaining([
        "archicode_queue_implementation",
        "archicode_run_guarded_command",
        "archicode_launch_run_app",
        "archicode_run_verification"
      ]));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("OpenAI Realtime event bridge", () => {
  function eventBridge() {
    const callbacks = {
      onAssistantTranscript: vi.fn(),
      onError: vi.fn(),
      onFunctionCall: vi.fn(),
      onInputLevel: vi.fn(),
      onSessionCreated: vi.fn(),
      onStatus: vi.fn(),
      onUserTranscript: vi.fn()
    };
    return { bridge: new OpenAiRealtimeEventBridge(callbacks), callbacks };
  }

  it("persists completed user and audio assistant transcripts", () => {
    const { bridge, callbacks } = eventBridge();
    bridge.handle(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "What changed?"
    }));
    bridge.handle(JSON.stringify({ type: "response.output_audio_transcript.delta", item_id: "reply-1", delta: "The build " }));
    bridge.handle(JSON.stringify({ type: "response.output_audio_transcript.delta", item_id: "reply-1", delta: "passed." }));
    bridge.handle(JSON.stringify({ type: "response.output_audio_transcript.done", item_id: "reply-1" }));

    expect(callbacks.onUserTranscript).toHaveBeenCalledWith("What changed?");
    expect(callbacks.onAssistantTranscript).toHaveBeenCalledWith("The build passed.");
  });

  it("persists text-only responses from the GA output text events", () => {
    const { bridge, callbacks } = eventBridge();
    bridge.handle(JSON.stringify({ type: "response.output_text.delta", item_id: "reply-2", delta: "Text " }));
    bridge.handle(JSON.stringify({ type: "response.output_text.delta", item_id: "reply-2", delta: "mode" }));
    bridge.handle(JSON.stringify({ type: "response.output_text.done", item_id: "reply-2", text: "Text mode complete" }));

    expect(callbacks.onAssistantTranscript).toHaveBeenCalledOnce();
    expect(callbacks.onAssistantTranscript).toHaveBeenCalledWith("Text mode complete");
  });

  it("tracks the authoritative session start and only becomes idle after a response completes", () => {
    const { bridge, callbacks } = eventBridge();
    bridge.handle(JSON.stringify({ type: "session.created", session: { id: "realtime-session-1" } }));
    bridge.handle(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    bridge.handle(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));

    expect(callbacks.onSessionCreated).toHaveBeenCalledWith("realtime-session-1");
    expect(callbacks.onStatus).toHaveBeenCalledTimes(2);
    expect(callbacks.onStatus).toHaveBeenLastCalledWith("thinking");

    bridge.handle(JSON.stringify({ type: "response.done", response: { output: [] } }));
    expect(callbacks.onStatus).toHaveBeenLastCalledWith("listening");
  });

  it("does not become idle when audio ends before the response itself", () => {
    const { bridge, callbacks } = eventBridge();
    bridge.handle(JSON.stringify({ type: "response.created" }));
    bridge.handle(JSON.stringify({ type: "response.output_audio.started" }));
    bridge.handle(JSON.stringify({ type: "response.output_audio.done" }));

    expect(callbacks.onStatus).toHaveBeenLastCalledWith("speaking");
    bridge.handle(JSON.stringify({ type: "response.done", response: { output: [] } }));
    expect(callbacks.onStatus).toHaveBeenLastCalledWith("listening");
  });

  it("deduplicates function calls emitted through multiple lifecycle events", () => {
    const { bridge, callbacks } = eventBridge();
    const call = { call_id: "call-1", name: "archicode_refresh_project_context", arguments: "{}" };
    bridge.handle(JSON.stringify({ type: "response.function_call_arguments.done", ...call }));
    bridge.handle(JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", ...call } }));
    bridge.handle(JSON.stringify({ type: "response.done", response: { output: [{ type: "function_call", ...call }] } }));

    expect(callbacks.onFunctionCall).toHaveBeenCalledOnce();
    expect(callbacks.onFunctionCall).toHaveBeenCalledWith({
      argumentsJson: "{}",
      callId: "call-1",
      name: "archicode_refresh_project_context"
    });
  });
});

describe("OpenAI Realtime call events", () => {
  it("does not fail the Live session when a duplicate response races an active response", () => {
    let messageListener: ((event: { data: string }) => void) | undefined;
    const onError = vi.fn();
    const dataChannel = {
      addEventListener: vi.fn((type: string, listener: (event: { data: string }) => void) => {
        if (type === "message") messageListener = listener;
      }),
      close: vi.fn(),
      readyState: "open",
      send: vi.fn()
    };
    class FakePeerConnection {
      addEventListener = vi.fn();
      close = vi.fn();
      createDataChannel = vi.fn(() => dataChannel);
    }
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    try {
      new OpenAiRealtimeCall({
        onAssistantTranscript: vi.fn(),
        onError,
        onFunctionCall: vi.fn(),
        onInputLevel: vi.fn(),
        onSessionCreated: vi.fn(),
        onStatus: vi.fn(),
        onUserTranscript: vi.fn()
      });

      messageListener?.({ data: JSON.stringify({
        type: "error",
        error: { message: "Conversation already has an active response in progress: resp_123." }
      }) });
      expect(onError).not.toHaveBeenCalled();

      messageListener?.({ data: JSON.stringify({
        type: "error",
        error: { message: "A different Realtime failure." }
      }) });
      expect(onError).toHaveBeenCalledWith("A different Realtime failure.");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("requests one response only after a non-empty user audio transcript", () => {
    const sent: Array<{ type?: string }> = [];
    let messageListener: ((event: { data: string }) => void) | undefined;
    const onUserTranscript = vi.fn();
    const dataChannel = {
      addEventListener: vi.fn((type: string, listener: (event: { data: string }) => void) => {
        if (type === "message") messageListener = listener;
      }),
      close: vi.fn(),
      readyState: "open",
      send: vi.fn((raw: string) => sent.push(JSON.parse(raw)))
    };
    class FakePeerConnection {
      addEventListener = vi.fn();
      close = vi.fn();
      createDataChannel = vi.fn(() => dataChannel);
    }
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    try {
      new OpenAiRealtimeCall({
        onAssistantTranscript: vi.fn(),
        onError: vi.fn(),
        onFunctionCall: vi.fn(),
        onInputLevel: vi.fn(),
        onSessionCreated: vi.fn(),
        onStatus: vi.fn(),
        onUserTranscript
      });

      messageListener?.({ data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "   "
      }) });
      expect(sent.filter((event) => event.type === "response.create")).toHaveLength(0);

      messageListener?.({ data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Hi there"
      }) });
      expect(onUserTranscript).toHaveBeenCalledWith("Hi there");
      expect(sent.filter((event) => event.type === "response.create")).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("requests a response when announcing newly completed background work", () => {
    const sent: unknown[] = [];
    const dataChannel = {
      addEventListener: vi.fn(),
      close: vi.fn(),
      readyState: "open",
      send: vi.fn((raw: string) => sent.push(JSON.parse(raw)))
    };
    class FakePeerConnection {
      addEventListener = vi.fn();
      close = vi.fn();
      createDataChannel = vi.fn(() => dataChannel);
    }
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    try {
      const call = new OpenAiRealtimeCall({
        onAssistantTranscript: vi.fn(),
        onError: vi.fn(),
        onFunctionCall: vi.fn(),
        onInputLevel: vi.fn(),
        onSessionCreated: vi.fn(),
        onStatus: vi.fn(),
        onUserTranscript: vi.fn()
      });

      call.appendDeveloperContext("Background Research completed.", true);

      expect(sent).toEqual([
        expect.objectContaining({ type: "conversation.item.create" }),
        { type: "response.create" }
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("queues a requested response until the active response is done", () => {
    const sent: Array<{ type?: string }> = [];
    let messageListener: ((event: { data: string }) => void) | undefined;
    const dataChannel = {
      addEventListener: vi.fn((type: string, listener: (event: { data: string }) => void) => {
        if (type === "message") messageListener = listener;
      }),
      close: vi.fn(),
      readyState: "open",
      send: vi.fn((raw: string) => sent.push(JSON.parse(raw)))
    };
    class FakePeerConnection {
      addEventListener = vi.fn();
      close = vi.fn();
      createDataChannel = vi.fn(() => dataChannel);
    }
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    try {
      const call = new OpenAiRealtimeCall({
        onAssistantTranscript: vi.fn(),
        onError: vi.fn(),
        onFunctionCall: vi.fn(),
        onInputLevel: vi.fn(),
        onSessionCreated: vi.fn(),
        onStatus: vi.fn(),
        onUserTranscript: vi.fn()
      });

      call.appendDeveloperContext("First update.", true);
      call.appendDeveloperContext("Second update while the first response is active.", true);
      expect(sent.filter((event) => event.type === "response.create")).toHaveLength(1);

      messageListener?.({ data: JSON.stringify({ type: "response.output_audio.done" }) });
      expect(sent.filter((event) => event.type === "response.create")).toHaveLength(1);

      messageListener?.({ data: JSON.stringify({ type: "response.done", response: { output: [] } }) });
      expect(sent.filter((event) => event.type === "response.create")).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
