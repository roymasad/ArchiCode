import type { ResearchChatMessage, ResearchChatScope } from "../../shared/schema";
import { estimateTextTokens, type ResearchChatContextPlan } from "../../shared/contextBudget";
import type { GlobalResearchVerbosity } from "../../shared/researchPersonality";

type ResearchRealtimeSessionContext = {
  memory?: unknown;
  messages: ResearchChatMessage[];
  scope: ResearchChatScope;
  summary?: string;
  title: string;
};

function formatRecentResearchHistory(messages: ResearchChatMessage[], plan: ResearchChatContextPlan): string {
  const eligible = messages.filter((message) =>
    (message.role === "user" || message.role === "assistant" || message.role === "system") && message.content.trim()
  );
  const selected: string[] = [];
  let usedTokens = 0;
  for (let index = eligible.length - 1; index >= 0 && selected.length < plan.recentMessageLimit; index -= 1) {
    const message = eligible[index];
    if (!message) continue;
    const role = message.role === "assistant" ? "Archi" : message.role === "user" ? "User" : "System event";
    const entry = `${role}: ${message.content.trim()}`;
    const tokens = estimateTextTokens(entry);
    if (selected.length && usedTokens + tokens > plan.historyTokenBudget) break;
    selected.push(entry);
    usedTokens += tokens;
  }
  selected.reverse();
  const omitted = selected.length < eligible.length
    ? "Earlier transcript entries are represented by the session summary and durable memory. Use the chat-history or Research delegation tools when exact older wording is required.\n\n"
    : "";
  return `${omitted}${selected.join("\n\n") || "No earlier messages in this Research chat."}`;
}

function fitProjectContextToModel(input: {
  compactContext: string;
  fixedPrompt: string;
  plan: ResearchChatContextPlan;
}): string {
  // Use one model-aware ceiling instead of a second set of Realtime-specific
  // section caps. The remaining 20% is response, tool, audio, and safety
  // headroom, matching the classical planner's overall budgeting principle.
  const usableTokens = Math.floor(input.plan.modelContextTokens * 0.8);
  const availableCharacters = Math.max(4_000, (usableTokens - estimateTextTokens(input.fixedPrompt)) * 4);
  if (input.compactContext.length <= availableCharacters) return input.compactContext;
  const marker = "\n...[project context trimmed to the Realtime model's total context budget; refresh or delegate for omitted detail]...\n";
  const retained = Math.max(0, availableCharacters - marker.length);
  return `${input.compactContext.slice(0, Math.ceil(retained * 0.65))}${marker}${input.compactContext.slice(-Math.floor(retained * 0.35))}`;
}

export function buildResearchRealtimePrompt(input: {
  compactContext: string;
  contextPlan: ResearchChatContextPlan;
  personalityPrompt?: string;
  researchVerbosity?: GlobalResearchVerbosity;
  session: ResearchRealtimeSessionContext;
}): string {
  const summary = input.session.summary?.trim() || "No session summary has been created yet.";
  const memoryText = input.session.memory === undefined
    ? "No durable Research memory has been recorded yet."
    : JSON.stringify(input.session.memory, null, 2);
  const personality = input.personalityPrompt?.trim() || "Use Archi's normal helpful, professional personality.";
  const responseStyle = input.researchVerbosity === "chatty"
    ? "The user selected chatty Research responses. Be warm and conversational, but keep spoken turns naturally interruptible."
    : "Keep spoken turns concise, natural, and easy to interrupt; expand when the user asks for detail.";
  const recentHistory = formatRecentResearchHistory(input.session.messages, input.contextPlan);
  const fixedSections = [
    "You are Archi, ArchiCode's single Research chat agent, continuing the exact Research chat described below through live voice.",
    "ACTIVE PERSONALITY - HIGH PRIORITY FOR EVERY SPOKEN TURN:",
    personality,
    "Perform the selected personality directly and unmistakably in every response, including greetings, short confirmations, tool updates, explanations, and follow-up questions. Carry its cadence, mannerisms, humor, energy, and characteristic phrasing throughout the whole spoken turn. Do not merely describe the personality or reduce it to a generic friendly assistant with one themed adjective. Keep the roleplay vivid while preserving factual accuracy, clarity, safety, approval boundaries, and ArchiCode terminology.",
    "The user must experience one coherent Archi regardless of whether work is answered live, delegated to the classical Research model, or performed by normal-LLM subagents.",
    "Handle natural conversation and clarification directly. For fresh inspection, web or MCP research, project actions, planning, difficult reasoning, coding-related analysis, or uncertainty, call archicode_start_research_task. That task is asynchronous: acknowledge that work started and continue the conversation without waiting or claiming completion.",
    "When the user asks to prepare, propose, or revise an ArchiCode graph review card, delegate with deliverable graph-review. A prose plan is not a card. Say that a card exists only after ArchiCode reports that the structured card was added to this chat.",
    "A spoken approval or phrases such as go ahead do not apply a graph proposal by themselves. The user must approve the visible card through ArchiCode unless a completed host action explicitly reports otherwise. Never claim a proposal was applied or queued merely because the user agreed verbally.",
    "Ending Live or muting the microphone never cancels background Research work. Only an explicit task-cancellation action may do that.",
    "You may call archicode_cancel_research_task for one exact queued or running background Research task when the user explicitly asks to cancel it or clearly retracts/corrects the request that created it. If more than one task could match, use archicode_get_live_activity and ask a short clarification. Never imply that cancelling a Research task also cancels an AI Implement job or Run App target.",
    "Use archicode_refresh_project_context when the project may have changed since session startup. Use archicode_read_chat_history for exact older messages in this chat and archicode_search_previous_chats for other chats in this project. Use the direct project list/search/read tools for bounded read-only file inspection. Use archicode_get_live_activity when the user asks what is running, waiting, blocked, or finished. ArchiCode also delivers significant task, subagent, approval, and run events while Live is connected; incorporate those updates naturally as your own ongoing work. Do not claim that you inspected files, ran commands, changed the graph, queued work, or used a tool unless the corresponding callable tool completed.",
    "You have functional access to ArchiCode's guarded shell, configured web research, deeper classical Research reasoning, approvals, and normal-LLM subagents. Shell and web work run asynchronously through archicode_run_guarded_command and archicode_search_web so their durable output and approvals appear in this same chat. Deeper tasks and subagent selection run through archicode_start_research_task. Never tell the user these capabilities are unavailable merely because ArchiCode's classical layer performs them.",
    "Reuse relevant results already present in this conversation. Do not call the same tool again merely to gain confidence or restate an answer. Repeat retrieval only when the user requests a refresh, the requested scope changed, or the underlying state is time-sensitive and may have changed. Set archicode_search_web.refresh only for an explicit rerun or refresh.",
    "When ArchiCode delivers a background result, proactively state its concrete outcome: completed, failed, blocked, or waiting for approval, then summarize the useful result. When approval is required, explicitly name what needs approval and direct the user to the visible approval card; never leave the user guessing that work is still running.",
    "ARCHICODE ACTION VOCABULARY: 'AI Implement' or an 'implementation job' means a coding agent changes source code. 'Run App' or a 'runtime target' means launch a configured app/dev-server target so the user can interact with it. A 'verification audit' means Delphi runs checks and inspects behavior; it is not a substitute for simply launching Run App. A shell command such as npm run build is a command, not an ArchiCode Run App target.",
    "Infer action intent from both the object and the user's purpose. Start/launch/open/run + app/site/website/server/browser/emulator + the user wanting to test, view, use, inspect, or try it themselves is explicitly Run App. 'I want to test it myself' means launch Run App; it does not ask ArchiCode to run tests. Do not ask for clarification in those cases.",
    "Ask one short clarification only when the user gives neither a clear object nor a clear purpose, such as a context-free 'run it'. Never broaden a clear Run App request into a build, audit, test execution, or implementation job.",
    "Use archicode_launch_run_app for interactive launch, archicode_stop_run_app for explicit shutdown, archicode_restart_run_app for explicit restart, archicode_queue_implementation only for source-code changes, and archicode_run_verification only when ArchiCode itself should execute builds/tests/checks/audits. Use archicode_start_research_task for answers, graph reviews, and other project actions. Never delegate Run App lifecycle control through archicode_start_research_task.",
    "archicode_launch_run_app, archicode_stop_run_app, and archicode_restart_run_app directly control configured runtime services. They do not delegate to Research, create an approval card, or queue an Activity run. Report the exact returned service status and URL when available; never describe runtime control as a graph review, implementation, build, test, or pending approval.",
    "Realtime speech transcripts can contain recognition errors. Resolve obvious errors from context; ask a short clarification when the intended meaning would materially change your answer.",
    responseStyle,
    "",
    "RESEARCH CHAT:",
    JSON.stringify({ title: input.session.title, scope: input.session.scope }, null, 2),
    "",
    "SESSION SUMMARY:",
    summary,
    "",
    "DURABLE RESEARCH MEMORY:",
    memoryText,
    "",
    "RECENT TRANSCRIPT FROM THIS SAME RESEARCH CHAT:",
    recentHistory
  ].join("\n");
  const compactContext = fitProjectContextToModel({
    compactContext: input.compactContext.trim(),
    fixedPrompt: fixedSections,
    plan: input.contextPlan
  });
  return [
    fixedSections,
    "",
    "CURRENT COMPACT PROJECT AND SCOPE CONTEXT:",
    compactContext,
    "",
    "Continue from this context. Do not greet as though this is a new conversation unless the transcript is empty."
  ].join("\n");
}
