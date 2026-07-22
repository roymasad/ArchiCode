import { createHash } from "node:crypto";
import {
  codexRealtimeV2Voices,
  defaultCodexRealtimeModel,
  defaultCodexRealtimeV2Voice,
  type CodexRealtimeModel,
  type CodexRealtimeVoice
} from "../shared/schema";

/**
 * The public surface keeps the original CodexRealtime names for a small,
 * reviewable migration. Sessions no longer pass through Codex: Electron main
 * mints a short-lived OpenAI Realtime credential and the renderer connects by
 * WebRTC.
 */
export type CodexRealtimeVoices = {
  v1: CodexRealtimeVoice[];
  v2: CodexRealtimeVoice[];
  defaultV1: CodexRealtimeVoice;
  defaultV2: CodexRealtimeVoice;
};

export type CodexRealtimeStatus = {
  available: boolean;
  authMode?: string | null;
  command: string;
  message: string;
  realtimeAvailable: boolean;
  version?: string;
  voices?: CodexRealtimeVoices;
};

export type CodexRealtimeStartInput = {
  includeStartupContext?: boolean;
  model?: string | null;
  outputModality?: "text" | "audio";
  projectRoot?: string | null;
  prompt?: string | null;
  researchSessionId?: string | null;
  voice: CodexRealtimeVoice;
};

export type CodexRealtimeClientSecret = {
  expiresAt: number;
  model: string;
  sessionId: string | null;
  value: string;
  voice: CodexRealtimeVoice;
};

const OPENAI_REALTIME_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
const CLIENT_SECRET_TTL_SECONDS = 120;

const asyncResearchTool = {
  type: "function",
  name: "archicode_start_research_task",
  description: [
    "Start a non-blocking background task using ArchiCode's full classical Research agent.",
    "Use this for fresh project or file inspection, web or MCP research, planning, coding-related analysis, graph actions, approvals, or any request that benefits from deeper reasoning.",
    "Choose graph-review for a graph proposal, project-action for another host action, and answer for analysis or information.",
    "Run App, AI Implement, and verification each have their own dedicated tool; do not route those actions through this generic tool.",
    "The task continues if Live ends. This call returns immediately; never imply that the result is already complete."
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "A self-contained description of what the Research agent should investigate or accomplish."
      },
      deliverable: {
        type: "string",
        enum: ["answer", "graph-review", "project-action"],
        description: "The concrete result ArchiCode must receive. graph-review requires a visible graph change-set card; answer and project-action do not launch Run App, queue implementation, or run verification."
      }
    },
    required: ["task", "deliverable"],
    additionalProperties: false
  }
} as const;

const runAppResearchTool = {
  type: "function",
  name: "archicode_launch_run_app",
  description: [
    "Directly launch an existing configured Run App/runtime target so the user can interact with the app, website, dev server, emulator, or browser target themselves.",
    "Use this without clarification when the user asks to start, launch, open, or run the app/site/website and says they want to test, view, use, or inspect it themselves.",
    "This does not create a Research task, approval card, Activity run, build, test, verification, audit, debug job, or source-code change. The user's explicit launch request authorizes this reversible runtime action."
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      profileId: { type: "string", description: "The exact configured Run App profile id from currentProjectOptions.commandsAndTargets.runTargets." },
      targetId: { type: "string", description: "Optional exact device, emulator, simulator, or runtime target id when the selected profile requires one." }
    },
    required: ["profileId"],
    additionalProperties: false
  }
} as const;

const stopRunAppTool = {
  type: "function",
  name: "archicode_stop_run_app",
  description: "Directly stop one exact live Run App runtime service when the user explicitly asks to shut down or stop it. Use the service id returned by archicode_launch_run_app or archicode_get_live_activity. This does not create a Research task, review card, or Activity run.",
  parameters: {
    type: "object",
    properties: {
      serviceId: { type: "string", description: "The exact live runtime service id." }
    },
    required: ["serviceId"],
    additionalProperties: false
  }
} as const;

const restartRunAppTool = {
  type: "function",
  name: "archicode_restart_run_app",
  description: "Directly restart one exact Run App runtime service when the user explicitly asks to restart it. Use the service id returned by archicode_launch_run_app or archicode_get_live_activity. This does not create a Research task, review card, or Activity run.",
  parameters: {
    type: "object",
    properties: {
      serviceId: { type: "string", description: "The exact runtime service id to restart." }
    },
    required: ["serviceId"],
    additionalProperties: false
  }
} as const;

const implementationResearchTool = {
  type: "function",
  name: "archicode_queue_implementation",
  description: "Queue AI Implement coding work that changes project source files. Use only when the user wants code created or modified; never use it merely to launch an app or let the user test an existing target.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "A self-contained description of the requested source-code implementation." }
    },
    required: ["task"],
    additionalProperties: false
  }
} as const;

const verificationResearchTool = {
  type: "function",
  name: "archicode_run_verification",
  description: "Run tests, builds, checks, or a Delphi behavioral audit. Use only when the user asks ArchiCode to perform verification; never use it when the user wants the app launched so they can test it themselves.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "A self-contained description of the checks, build, tests, or audit ArchiCode should execute." }
    },
    required: ["task"],
    additionalProperties: false
  }
} as const;

const researchTaskStatusTool = {
  type: "function",
  name: "archicode_get_research_task_status",
  description: "Read the current status and available result summary for a background Research task.",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "The task id returned by archicode_start_research_task." }
    },
    required: ["taskId"],
    additionalProperties: false
  }
} as const;

const cancelResearchTaskTool = {
  type: "function",
  name: "archicode_cancel_research_task",
  description: [
    "Cancel one specific queued or running background Research task created by archicode_start_research_task.",
    "Use only when the user explicitly asks to cancel that task or clearly corrects/retracts the request that created it.",
    "This does not cancel unrelated Research tasks, AI Implement coding jobs, Run App targets, or other project runs. Read live activity first when the intended task id is uncertain."
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "The exact background Research task id to cancel." }
    },
    required: ["taskId"],
    additionalProperties: false
  }
} as const;

const freshProjectContextTool = {
  type: "function",
  name: "archicode_refresh_project_context",
  description: "Reload ArchiCode's current compact project and chat context when the project may have changed since this Live session started.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
} as const;

const liveActivityTool = {
  type: "function",
  name: "archicode_get_live_activity",
  description: "Inspect current background Research tasks, AI Implement coding jobs, and directly managed runtime services when the user asks what is working, waiting, blocked, or recently completed.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
} as const;

const currentChatHistoryTool = {
  type: "function",
  name: "archicode_read_chat_history",
  description: "Search or read older messages from the currently open Research chat when the startup summary, memory, and recent transcript do not contain enough exact detail.",
  parameters: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["search", "slice"] },
      query: { type: "string", description: "Case-insensitive text to find when mode is search." },
      beforeMessageId: { type: "string" },
      afterMessageId: { type: "string" },
      aroundMessageId: { type: "string" },
      roles: { type: "array", items: { type: "string", enum: ["user", "assistant", "system"] } },
      maxMessages: { type: "integer", minimum: 1, maximum: 24 },
      maxChars: { type: "integer", minimum: 500, maximum: 16_000 }
    },
    required: ["mode"],
    additionalProperties: false
  }
} as const;

const previousChatsTool = {
  type: "function",
  name: "archicode_search_previous_chats",
  description: "Search or list other Research chats in this project by title, saved summary, and message content. Use this for explicit questions about previous, recent, older, or past chats.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Optional case-insensitive text to find. Omit to list chats by time." },
      sort: { type: "string", enum: ["recent", "oldest"] },
      maxResults: { type: "integer", minimum: 1, maximum: 20 },
      maxChars: { type: "integer", minimum: 500, maximum: 20_000 }
    },
    additionalProperties: false
  }
} as const;

const projectListFilesTool = {
  type: "function",
  name: "archicode_project_list_files",
  description: "Directly list files and directories inside the current project root. This is read-only and does not start a background task.",
  parameters: {
    type: "object",
    properties: {
      directory: { type: "string", description: "Project-relative directory. Defaults to the project root." },
      recursive: { type: "boolean" },
      maxResults: { type: "integer", minimum: 1, maximum: 500 }
    },
    additionalProperties: false
  }
} as const;

const projectSearchFilesTool = {
  type: "function",
  name: "archicode_project_search_files",
  description: "Directly search readable project files by path and text content. This is read-only and does not start a background task.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text or path fragment to search for." },
      directory: { type: "string", description: "Optional project-relative directory restriction." },
      maxResults: { type: "integer", minimum: 1, maximum: 100 }
    },
    required: ["query"],
    additionalProperties: false
  }
} as const;

const projectReadFileTool = {
  type: "function",
  name: "archicode_project_read_file",
  description: "Directly read a readable project file by project-relative path. Secrets are redacted and long files are bounded.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Project-relative file path." },
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
      maxChars: { type: "integer", minimum: 1, maximum: 80_000 }
    },
    required: ["path"],
    additionalProperties: false
  }
} as const;

const guardedCommandTool = {
  type: "function",
  name: "archicode_run_guarded_command",
  description: [
    "Run one bounded project shell command through ArchiCode's classical Research agent and shared safety broker.",
    "The call is asynchronous so command output, failures, and any required approval remain durable and visible in the same chat.",
    "Use this when the user asks for a shell command or when command output materially advances the request. Do not claim the command completed until ArchiCode reports the background result."
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The exact bounded command to run." },
      cwd: { type: "string", description: "Optional project-relative working directory." },
      purpose: { type: "string", description: "Why this command is needed and what result should be reported." }
    },
    required: ["command", "purpose"],
    additionalProperties: false
  }
} as const;

const webResearchTool = {
  type: "function",
  name: "archicode_search_web",
  description: [
    "Start a non-blocking web research task through ArchiCode's classical Research agent and configured web-search provider.",
    "Use this for current online facts and source-backed research. This returns immediately; do not claim results until the background result arrives."
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The exact web research question or search query." },
      purpose: { type: "string", description: "What the user needs from the results." },
      refresh: { type: "boolean", description: "Set true only when the user explicitly asks to rerun or refresh an otherwise identical recent search." }
    },
    required: ["query", "purpose"],
    additionalProperties: false
  }
} as const;

function openAiErrorMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    const message = parsed.error?.message?.trim();
    if (message) return message;
  } catch {
    // The API may return a plain-text proxy or transport error.
  }
  return body.trim() || `OpenAI Realtime request failed (${status}).`;
}

function safetyIdentifier(projectRoot?: string | null): string | undefined {
  const root = projectRoot?.trim();
  if (!root) return undefined;
  return createHash("sha256").update(root).digest("hex");
}

function realtimeSessionConfig(input: CodexRealtimeStartInput, prompt: string) {
  const model = input.model?.trim() || defaultCodexRealtimeModel;
  const voice = (codexRealtimeV2Voices as readonly string[]).includes(input.voice)
    ? input.voice
    : defaultCodexRealtimeV2Voice;
  return {
    type: "realtime",
    model,
    output_modalities: [input.outputModality === "text" ? "text" : "audio"],
    instructions: prompt,
    audio: {
      input: {
        transcription: { model: "gpt-realtime-whisper" },
        noise_reduction: { type: "near_field" },
        turn_detection: {
          type: "semantic_vad",
          eagerness: "auto",
          create_response: false,
          interrupt_response: true
        }
      },
      output: {
        voice,
        speed: 1
      }
    },
    ...(model.startsWith("gpt-realtime-2") ? { reasoning: { effort: "low" } } : {}),
    tools: [
      asyncResearchTool,
      runAppResearchTool,
      stopRunAppTool,
      restartRunAppTool,
      implementationResearchTool,
      verificationResearchTool,
      researchTaskStatusTool,
      cancelResearchTaskTool,
      freshProjectContextTool,
      liveActivityTool,
      currentChatHistoryTool,
      previousChatsTool,
      projectListFilesTool,
      projectSearchFilesTool,
      projectReadFileTool,
      guardedCommandTool,
      webResearchTool
    ],
    tool_choice: "auto",
    tracing: "auto"
  };
}

async function requestClientSecret(apiKey: string, input: CodexRealtimeStartInput, prompt: string): Promise<CodexRealtimeClientSecret> {
  const key = apiKey.trim();
  if (!key) throw new Error("Add an OpenAI API key in ArchiCode Project Settings > Advanced > Voice mode.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const identifier = safetyIdentifier(input.projectRoot);
    const response = await fetch(OPENAI_REALTIME_CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(identifier ? { "OpenAI-Safety-Identifier": identifier } : {})
      },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: CLIENT_SECRET_TTL_SECONDS },
        session: realtimeSessionConfig(input, prompt)
      }),
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) throw new Error(openAiErrorMessage(body, response.status));
    const parsed = JSON.parse(body) as {
      value?: string;
      expires_at?: number;
      session?: { id?: string; model?: string; audio?: { output?: { voice?: string } } };
    };
    if (!parsed.value) throw new Error("OpenAI did not return a Realtime client secret.");
    const configured = realtimeSessionConfig(input, prompt);
    return {
      value: parsed.value,
      expiresAt: parsed.expires_at ?? Math.floor(Date.now() / 1000) + CLIENT_SECRET_TTL_SECONDS,
      sessionId: parsed.session?.id ?? null,
      model: parsed.session?.model ?? configured.model,
      voice: (parsed.session?.audio?.output?.voice as CodexRealtimeVoice | undefined) ?? configured.audio.output.voice
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("OpenAI Realtime session setup timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getCodexRealtimeStatus(apiKey?: string, model: CodexRealtimeModel = defaultCodexRealtimeModel): Promise<CodexRealtimeStatus> {
  if (!apiKey?.trim()) {
    return {
      available: true,
      authMode: null,
      command: "OpenAI API",
      message: "Add and save an OpenAI API key to use Realtime voice.",
      realtimeAvailable: false
    };
  }
  try {
    await requestClientSecret(apiKey, {
      model,
      outputModality: "audio",
      voice: defaultCodexRealtimeV2Voice
    }, "You are checking whether this OpenAI API key can create an ArchiCode Realtime session. Do not respond.");
    const voices = [...codexRealtimeV2Voices];
    return {
      available: true,
      authMode: "apikey",
      command: "OpenAI API",
      message: "OpenAI Realtime is available with the saved API key.",
      realtimeAvailable: true,
      voices: {
        v1: voices,
        v2: voices,
        defaultV1: defaultCodexRealtimeV2Voice,
        defaultV2: defaultCodexRealtimeV2Voice
      }
    };
  } catch (error) {
    return {
      available: true,
      authMode: "apikey",
      command: "OpenAI API",
      message: error instanceof Error ? error.message : "OpenAI Realtime availability check failed.",
      realtimeAvailable: false
    };
  }
}

export async function createCodexRealtimeClientSecret(input: CodexRealtimeStartInput & { apiKey: string; prompt: string }): Promise<CodexRealtimeClientSecret> {
  return requestClientSecret(input.apiKey, input, input.prompt);
}
