import type { MicroRunAgent, MicroRunContext, MicroRunToolInvocation } from "../microRuns";
import { sherlockResearchInputSchema, type SherlockResearchInput, type SherlockResearchOutput } from "../../shared/schema";
import { createReadOnlyInvestigationTools, extractJsonObject } from "./readOnlyTools";
import { createGuardedConsoleTool } from "./guardedConsole";

const SHERLOCK_TIMEOUT_MS = 45 * 60 * 1000;

function includeWeb(input: SherlockResearchInput, context: MicroRunContext): boolean {
  return context.bundle.project.settings.webSearch.enabled && (input.mode === "online" || input.mode === "mixed");
}

function systemPrompt(input: unknown, context: MicroRunContext): string {
  const task = sherlockResearchInputSchema.parse(input);
  const webAllowed = includeWeb(task, context);
  return [
    "You are Sherlock, ArchiCode's private-detective research subagent.",
    "Work in a fresh isolated context and investigate the assigned objective deeply without modifying source files, project settings, runs, or the graph.",
    "A shared guarded CLI is available when direct project inspection or diagnostics materially improve the investigation. Choose commands and iteration autonomously; the host evaluates their actual scope and risk. Do not use it to bypass your read-only research role.",
    "Use project tools to gather direct evidence before drawing conclusions. Distinguish facts, inferences, and unresolved possibilities.",
    task.mode === "codebase" || task.mode === "mixed"
      ? "For codebase work, inspect the relevant source tree and source files—not only root configuration or dependency manifests. Do not finalize until you have read or searched the code paths needed to support the conclusion."
      : "",
    webAllowed
      ? "Online research is allowed. Prefer primary sources, record URLs, and cite every time-sensitive or externally sourced claim."
      : "Online research is unavailable for this task. Do not claim that current external facts were verified.",
    "Keep raw investigation inside this run. Return a compact evidence dossier for the caller instead of a transcript.",
    "Do not spawn another agent. Do not ask the caller to perform investigation you can perform with the available project, web, or guarded CLI tools.",
    "Never claim project tools are unavailable after they have returned results. If a required tool genuinely fails, identify the exact failed tool/path and return the limitation honestly instead of presenting an incomplete investigation as completed.",
    "Return one JSON object with: status, blockers, summary, findings, sources, openQuestions, recommendedNextSteps.",
    "Set status to completed only when the assigned investigation is complete. If required evidence cannot be collected, set status to blocked and list the concrete tool, path, access, or evidence blockers in blockers.",
    "Each finding must contain title, detail, evidence entries with source/reference/optional excerpt, and confidence low/medium/high.",
    `Research mode: ${task.mode}.`,
    task.scope ? `Declared scope: ${task.scope}` : "",
    task.codePaths.length ? `Priority code paths: ${task.codePaths.join(", ")}` : "",
    task.evidenceRequirements.length ? `Evidence requirements: ${task.evidenceRequirements.join("; ")}` : ""
  ].filter(Boolean).join("\n");
}

function validateOutput(output: unknown, toolCalls: MicroRunToolInvocation[], input: unknown): string | undefined {
  const task = sherlockResearchInputSchema.parse(input);
  const dossier = output as SherlockResearchOutput;
  if (dossier.status === "blocked") {
    if (!dossier.blockers.length) {
      return "Sherlock marked the investigation blocked without naming a concrete evidence or access blocker.";
    }
    const claimedUnavailableTool = dossier.blockers.some((blocker) =>
      /\b(?:tool|tools|project reader|project search|structured research).{0,120}\b(?:unavailable|not available|not accessible|not provided)\b/i.test(blocker) ||
      /\b(?:unavailable|not available|not accessible|not provided)\b.{0,120}\b(?:tool|tools|project reader|project search|structured research)\b/i.test(blocker)
    );
    const encounteredToolFailure = toolCalls.some((call) => call.succeeded === false);
    if (claimedUnavailableTool && !encounteredToolFailure) {
      return "Sherlock claimed an available investigation tool was unavailable without a failed tool invocation. Continue the same investigation and call the relevant listed read, search, web, or guarded CLI tool before reporting a blocker.";
    }
    return undefined;
  }
  if (dossier.blockers.length > 0) {
    return "Sherlock returned blockers while marking the investigation completed.";
  }
  const projectToolCalls = toolCalls.filter((call) => call.providerToolName.startsWith("archicode_project_"));
  const webToolCalls = toolCalls.filter((call) => call.providerToolName.startsWith("archicode_web_"));
  if (task.mode === "codebase" && projectToolCalls.length === 0) {
    return "Sherlock completed a codebase investigation without using any project evidence tools.";
  }
  if (task.mode === "online" && webToolCalls.length === 0) {
    return "Sherlock completed an online investigation without using any web evidence tools.";
  }
  if (task.mode === "mixed" && projectToolCalls.length === 0 && webToolCalls.length === 0) {
    return "Sherlock completed a mixed investigation without using any project or web evidence tools.";
  }
  const sourceInspectionRequired = task.mode === "codebase" || task.codePaths.length > 0;
  if (sourceInspectionRequired) {
    const inspectedSource = projectToolCalls.some((call) => {
      if (call.providerToolName !== "archicode_project_read_file" && call.providerToolName !== "archicode_project_search_files") return false;
      try {
        const args = JSON.parse(call.argumentsJson || "{}") as Record<string, unknown>;
        const target = typeof args.path === "string" ? args.path : typeof args.directory === "string" ? args.directory : "";
        return call.providerToolName === "archicode_project_search_files" || Boolean(target && !/^(?:package(?:-lock)?\.json|README\.md|\.gitignore)$/i.test(target));
      } catch {
        return false;
      }
    });
    if (!inspectedSource) {
      return "Sherlock completed a source investigation after inspecting only project-level metadata; no source file read or source search was performed.";
    }
  }
  if (!dossier.summary.trim()) {
    return "Sherlock completed without a structured summary.";
  }
  if (dossier.findings.length === 0) {
    return "Sherlock completed without any structured findings in its evidence dossier.";
  }
  const unsupportedFinding = dossier.findings.find((finding) => finding.evidence.length === 0);
  if (unsupportedFinding) {
    return `Sherlock returned a finding without evidence: ${unsupportedFinding.title}`;
  }
  if ((task.mode === "codebase" || task.mode === "online" || task.mode === "mixed") && dossier.sources.length === 0) {
    return "Sherlock completed without a structured sources list.";
  }
  return undefined;
}

function userMessage(input: unknown): string {
  const task = sherlockResearchInputSchema.parse(input);
  return `Investigate this objective and return the compact evidence dossier only:\n\n${task.objective}`;
}

function evidenceSourceType(source: string, reference: string): SherlockResearchOutput["sources"][number]["sourceType"] {
  const combined = `${source} ${reference}`;
  if (/https?:\/\//i.test(combined)) return "web";
  if (/\b(?:documentation|docs?)\b/i.test(source)) return "documentation";
  if (/^(?:project|codebase|repository|source)$/i.test(source.trim()) || /(?:^|[/\\])?[^/\\]+\.[a-z0-9]+(?::\d+)?\b/i.test(combined)) {
    return "project-file";
  }
  return "other";
}

/**
 * Finding evidence already contains the same source/reference facts as the
 * dossier's convenience `sources` index. Some providers reliably emit all
 * evidence-backed findings but omit that redundant final array (especially on
 * long audits). Recover the index instead of turning a useful report into a
 * false failure.
 */
function sourcesFromFindingEvidence(findings: SherlockResearchOutput["findings"]): SherlockResearchOutput["sources"] {
  const seen = new Set<string>();
  return findings.flatMap((finding) => finding.evidence.flatMap((evidence) => {
    const label = evidence.source.trim();
    const reference = evidence.reference.trim();
    if (!label || !reference) return [];
    const sourceType = evidenceSourceType(label, reference);
    const key = `${sourceType}\u0000${label}\u0000${reference}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ label, reference, sourceType }];
  }));
}

function parseOutput(text: string): SherlockResearchOutput {
  const parsed = extractJsonObject(text);
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const rawSources = Array.isArray(parsed.sources) ? parsed.sources : [];
  const findings: SherlockResearchOutput["findings"] = rawFindings.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.title !== "string" || typeof record.detail !== "string") return [];
    const confidence = record.confidence === "low" || record.confidence === "medium" || record.confidence === "high"
      ? record.confidence
      : "medium";
    const evidence = Array.isArray(record.evidence) ? record.evidence.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const evidenceRecord = entry as Record<string, unknown>;
      if (typeof evidenceRecord.source !== "string" || typeof evidenceRecord.reference !== "string") return [];
      return [{
        source: evidenceRecord.source,
        reference: evidenceRecord.reference,
        excerpt: typeof evidenceRecord.excerpt === "string" ? evidenceRecord.excerpt : undefined
      }];
    }) : [];
    return [{ title: record.title, detail: record.detail, evidence, confidence }];
  });
  const explicitSources: SherlockResearchOutput["sources"] = rawSources.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.label !== "string" || typeof record.reference !== "string") return [];
    const sourceType = record.sourceType === "project-file" || record.sourceType === "web" || record.sourceType === "documentation" || record.sourceType === "other"
      ? record.sourceType
      : "other";
    return [{ label: record.label, reference: record.reference, sourceType }];
  });
  return {
    status: parsed.status === "blocked" ? "blocked" : "completed",
    blockers: Array.isArray(parsed.blockers) ? parsed.blockers.filter((item): item is string => typeof item === "string") : [],
    summary: typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : text.trim().slice(0, 4000) || "Sherlock completed the investigation without a structured summary.",
    findings,
    sources: explicitSources.length ? explicitSources : sourcesFromFindingEvidence(findings),
    openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions.filter((item): item is string => typeof item === "string") : [],
    recommendedNextSteps: Array.isArray(parsed.recommendedNextSteps) ? parsed.recommendedNextSteps.filter((item): item is string => typeof item === "string") : []
  };
}

function repairMessage(_input: unknown, outputText: string, validationError: string): string {
  return [
    "Your previous response did not satisfy Sherlock's evidence-dossier contract.",
    `Validation error: ${validationError}`,
    "Return exactly one JSON object with status, blockers, summary, findings, sources, openQuestions, and recommendedNextSteps. Every finding needs at least one source/reference evidence entry. Set status to blocked and populate blockers only when required evidence genuinely cannot be collected. Reuse evidence already gathered, and use the available read-only tools again if evidence is incomplete.",
    outputText.trim() ? `Previous response for repair context:\n${outputText.slice(0, 4_000)}` : ""
  ].filter(Boolean).join("\n\n");
}

export const sherlockResearchAgent: MicroRunAgent = {
  kind: "sherlock-research",
  systemPrompt,
  userMessage,
  tools: (context) => {
    const guardedConsole = createGuardedConsoleTool(context, {
      description: "Run a finite project-scoped diagnostic or inspection chosen for Sherlock's assigned investigation. The shared safety broker evaluates the actual action; this tool must not be used to modify the project.",
      progressLabel: "Running guarded investigation command"
    });
    return [
      ...createReadOnlyInvestigationTools(context, { includeWeb: true }),
      ...(guardedConsole ? [guardedConsole] : [])
    ];
  },
  webSearchEnabled: (input, context) => {
    const task = sherlockResearchInputSchema.parse(input);
    return includeWeb(task, context) && (context.bundle.project.settings.webSearch.provider ?? "native") === "native";
  },
  timeoutMs: SHERLOCK_TIMEOUT_MS,
  parseOutput,
  validateOutput,
  repairMessage
};
