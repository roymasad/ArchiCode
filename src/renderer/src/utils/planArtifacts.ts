import type { Artifact } from "@shared/schema";

type JsonRecord = Record<string, unknown>;

type PlanTask = {
  title: string;
  summary?: string;
  batchBudget?: number;
  lightVerificationCommand?: string;
  verificationCommand?: string;
};

type PlanCommandSummary = {
  light: string[];
  final: string[];
};

type PlanArtifactDerived = {
  hasGeneratedPlan: boolean;
  badgeLabel: string;
  listLabel: string;
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => asString(item)).filter((item): item is string => Boolean(item)) : [];
}

function asTaskArray(value: unknown): PlanTask[] {
  if (!Array.isArray(value)) return [];
  const tasks: Array<PlanTask | null> = value.map((item) => {
    const record = asRecord(item);
    if (!record) return null;
    const title = asString(record.title);
    if (!title) return null;
    const batchBudget = typeof record.batchBudget === "number" && Number.isFinite(record.batchBudget)
      ? Math.max(1, Math.floor(record.batchBudget))
      : undefined;
    return {
      title,
      summary: asString(record.summary) ?? undefined,
      batchBudget,
      lightVerificationCommand: asString(record.lightVerificationCommand) ?? undefined,
      verificationCommand: asString(record.verificationCommand) ?? undefined
    };
  });
  return tasks.filter((item): item is PlanTask => item !== null);
}

function parseJsonRecord(candidate: string): JsonRecord | null {
  try {
    return asRecord(JSON.parse(candidate));
  } catch {
    return null;
  }
}

function parseEmbeddedJson(text: string): JsonRecord | null {
  const trimmed = text.trim();
  const fencedMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const match of fencedMatches) {
    const parsed = parseJsonRecord(match[1]?.trim() ?? "");
    if (parsed) return parsed;
  }

  const direct = parseJsonRecord(trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim());
  if (direct) return direct;

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return parseJsonRecord(trimmed.slice(firstBrace, lastBrace + 1));
  }
  return null;
}

function planArtifactRootFromText(text: string): JsonRecord | null {
  return parseJsonRecord(text) ?? parseEmbeddedJson(text);
}

function stripFencedJson(text: string): string {
  return text.replace(/```(?:json)?\s*[\s\S]*?```/gi, "").trim();
}

function section(lines: string[], title: string, body: string[]): void {
  if (!body.length) return;
  if (lines.length) lines.push("");
  lines.push(title);
  lines.push(...body);
}

function scopeLines(scope: JsonRecord | null): string[] {
  if (!scope) return [];
  const values = [
    asString(scope.flowId) ? `Flow: ${asString(scope.flowId)}` : null,
    asString(scope.nodeId) ? `Node: ${asString(scope.nodeId)}` : null,
    asString(scope.providerId) ? `Provider: ${asString(scope.providerId)}` : null
  ].filter((item): item is string => Boolean(item));
  return values;
}

function taskLines(tasks: PlanTask[]): string[] {
  return tasks.flatMap((task, index) => {
    const lines = [`${index + 1}. ${task.title}`];
    if (task.summary) lines.push(`   ${task.summary}`);
    if (task.batchBudget) lines.push(`   Batch budget: ${task.batchBudget}`);
    if (task.lightVerificationCommand) lines.push(`   Light verification: ${task.lightVerificationCommand}`);
    if (task.verificationCommand) lines.push(`   Final verification: ${task.verificationCommand}`);
    return lines;
  });
}

function questionLines(patch: JsonRecord | null): string[] {
  if (!patch) return [];
  const runSummary = asRecord(patch.runSummary);
  const suggested = asStringArray(runSummary?.suggestedQuestions);
  if (suggested.length) return suggested.map((question) => `- ${question}`);
  const operations = Array.isArray(patch.operations) ? patch.operations : [];
  return operations
    .map((operation) => {
      const record = asRecord(operation);
      if (!record || record.kind !== "add-note") return null;
      const note = asRecord(record.note);
      return asString(note?.body);
    })
    .filter((item): item is string => Boolean(item))
    .map((question) => `- ${question}`);
}

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.trim().length > 0 || (index > 0 && lines[index - 1]?.trim().length > 0));
}

function cleanPlannerNotes(text: string, summary: string | null): string[] {
  return nonEmptyLines(text)
    .filter((line) => !/^Decision:\s*(ask_questions|proceed)\b/i.test(line))
    .filter((line) => !summary || line.trim() !== summary.trim());
}

function hasUserFacingPlanSections(text: string): boolean {
  const headings = [
    /^Goal\b/im,
    /^Approach\b/im,
    /^Key Assumptions\b/im,
    /^Implementation Steps\b/im,
    /^Verification\b/im,
    /^Risks\b/im
  ];
  return headings.filter((pattern) => pattern.test(text)).length >= 2;
}

function collectVerificationCommands(tasks: PlanTask[]): PlanCommandSummary {
  const light = Array.from(new Set(tasks.map((task) => task.lightVerificationCommand).filter((item): item is string => Boolean(item))));
  const final = Array.from(new Set(tasks.map((task) => task.verificationCommand).filter((item): item is string => Boolean(item))));
  return { light, final };
}

function combineBullets(primary: string[], secondary: string[] = []): string[] {
  return Array.from(new Set([...primary, ...secondary].map((item) => item.trim()).filter(Boolean))).map((item) => `- ${item}`);
}

function deriveApproach(tasks: PlanTask[], effort: string | null): string[] {
  if (!tasks.length) return effort ? [`Implementation effort: ${effort}.`] : [];
  const taskText = `${tasks.length} ordered implementation step${tasks.length === 1 ? "" : "s"}`;
  const effortText = effort ? ` using ${effort} effort` : "";
  return [`Execute ${taskText}${effortText}, keeping each step as a self-contained source slice with finite verification.`];
}

export function planArtifactHasGeneratedPlan(artifact: Pick<Artifact, "type" | "providerSummary" | "planOutputAt">): boolean {
  return artifact.type === "plan" && Boolean(artifact.providerSummary?.trim() || artifact.planOutputAt);
}

export function planArtifactBadgeLabel(artifact: Pick<Artifact, "type" | "providerSummary" | "planOutputAt">): string {
  if (artifact.type !== "plan") return artifact.type;
  return planArtifactHasGeneratedPlan(artifact) ? "plan" : "prompt";
}

export function planArtifactListLabel(artifact: Pick<Artifact, "type" | "summary" | "promptSummary" | "providerSummary" | "path">): string {
  if (artifact.type !== "plan") return artifact.summary ?? artifact.path;
  if (artifact.providerSummary?.trim()) return artifact.providerSummary.trim();
  if (artifact.promptSummary?.trim()) return `Prompt: ${artifact.promptSummary.trim()}`;
  return artifact.summary?.trim() || artifact.path;
}

export function planArtifactDerivedDisplay(
  artifact: Pick<Artifact, "type" | "summary" | "promptSummary" | "providerSummary" | "planOutputAt" | "path">,
  text?: string | null
): PlanArtifactDerived {
  if (artifact.type !== "plan") {
    return {
      hasGeneratedPlan: false,
      badgeLabel: artifact.type,
      listLabel: artifact.summary ?? artifact.path
    };
  }

  const fallbackHasGeneratedPlan = planArtifactHasGeneratedPlan(artifact);
  const fallbackListLabel = planArtifactListLabel(artifact);
  if (!text?.trim()) {
    return {
      hasGeneratedPlan: fallbackHasGeneratedPlan,
      badgeLabel: fallbackHasGeneratedPlan ? "plan" : "prompt",
      listLabel: fallbackListLabel
    };
  }

  const root = planArtifactRootFromText(text);
  if (!root) {
    return {
      hasGeneratedPlan: fallbackHasGeneratedPlan,
      badgeLabel: fallbackHasGeneratedPlan ? "plan" : "prompt",
      listLabel: fallbackListLabel
    };
  }

  const artifactPlan = asRecord(root.plan);
  const providerText = asString(root.text);
  const patchRoot = providerText ? parseEmbeddedJson(providerText) : root;
  const patch = asRecord(patchRoot?.archicodePatch) ?? patchRoot;
  const promptSummary = asString(root.promptSummary) ?? asString(artifactPlan?.intent) ?? asString(root.summary);
  const generatedSummary = asString(patch?.summary) ?? asString(root.providerSummary);
  const hasGeneratedPlan = Boolean(
    asString(root.providerSummary) ||
    asString(root.planOutputAt) ||
    providerText ||
    generatedSummary
  ) && Boolean(generatedSummary || providerText);

  if (hasGeneratedPlan) {
    return {
      hasGeneratedPlan: true,
      badgeLabel: "plan",
      listLabel: generatedSummary ?? fallbackListLabel
    };
  }

  return {
    hasGeneratedPlan: false,
    badgeLabel: "prompt",
    listLabel: promptSummary ? `Prompt: ${promptSummary}` : fallbackListLabel
  };
}

export function formatPlanArtifactText(text: string): string {
  const root = planArtifactRootFromText(text);
  if (!root) return text.trim();

  const artifactPlan = asRecord(root.plan);
  const promptSummary = asString(root.promptSummary) ?? asString(root.summary) ?? asString(artifactPlan?.intent);
  const providerText = asString(root.text);
  const providerPayloadRoot = providerText ? parseEmbeddedJson(providerText) : null;
  const patch = asRecord(providerPayloadRoot?.archicodePatch) ?? providerPayloadRoot;
  const runSummary = asRecord(patch?.runSummary);
  const decisionMatch = providerText?.match(/Decision:\s*(ask_questions|proceed)/i);
  const summary = asString(patch?.summary) ?? asString(root.providerSummary) ?? promptSummary;
  const plannerSummary = asString(root.providerSummary);
  const providerVisibleText = providerText ? stripFencedJson(providerText) : "";
  const plannerNotes = providerVisibleText ? cleanPlannerNotes(providerVisibleText, summary) : [];
  const tasks = asTaskArray(runSummary?.implementationTasks);
  const verificationCommands = collectVerificationCommands(tasks);
  const goal = asString(runSummary?.goal) ?? (summary && summary !== promptSummary ? summary : promptSummary ?? summary);
  const approach = asString(runSummary?.approach)
    ? [asString(runSummary?.approach) as string]
    : deriveApproach(tasks, asString(runSummary?.implementationEffort));
  const assumptions = combineBullets(
    asStringArray(runSummary?.assumptions),
    asStringArray(artifactPlan?.assumptions)
  );
  const risks = combineBullets(
    asStringArray(runSummary?.risks),
    asStringArray(artifactPlan?.risks)
  );
  const verification = combineBullets(
    [
      ...verificationCommands.light.map((command) => `Light verification: ${command}`),
      ...verificationCommands.final.map((command) => `Final verification: ${command}`),
      ...(asString(runSummary?.verificationPlan) ? [asString(runSummary?.verificationPlan) as string] : [])
    ],
    [
      ...asStringArray(artifactPlan?.testsExpected),
      ...asStringArray(artifactPlan?.commandsNeeded)
    ]
  );
  const lines: string[] = [];

  if (!providerText) {
    lines.push("Planning prompt");
    if (promptSummary) {
      lines.push("");
      lines.push(promptSummary);
    }
    section(lines, "Scope", scopeLines(asRecord(artifactPlan?.scope)));
    section(lines, "Commands Needed", asStringArray(artifactPlan?.commandsNeeded).map((item) => `- ${item}`));
    section(lines, "Tests Expected", asStringArray(artifactPlan?.testsExpected).map((item) => `- ${item}`));
    section(lines, "Allowed Roots", asStringArray(artifactPlan?.allowedRoots).map((item) => `- ${item}`));
    section(lines, "Assumptions", asStringArray(artifactPlan?.assumptions).map((item) => `- ${item}`));
    const promptOnly = lines.join("\n").trim();
    return promptOnly || text.trim();
  }

  if (hasUserFacingPlanSections(providerVisibleText)) {
    lines.push(providerVisibleText.trim());
    if (!/^Implementation Steps\b/im.test(providerVisibleText)) {
      section(lines, "Implementation Steps", taskLines(tasks));
    }
    if (!/^Verification\b/im.test(providerVisibleText)) {
      section(lines, "Verification", verification);
    }
    if (!/^Risks\b/im.test(providerVisibleText)) {
      section(lines, "Risks", risks);
    }
  } else {
    if (summary) lines.push(summary);
    if (decisionMatch?.[1]) {
      lines.push("");
      lines.push(`Decision: ${decisionMatch[1].toLowerCase()}`);
    }
    section(lines, "Goal", [goal].filter((item): item is string => Boolean(item)));
    section(lines, "Approach", approach);
    section(lines, "Key Assumptions", assumptions);
    section(lines, "Implementation Steps", taskLines(tasks));
    section(lines, "Verification", verification);
    section(lines, "Risks", risks);
    section(lines, "Open Questions", questionLines(patch));
    section(lines, "Planner Notes", plannerNotes);
    section(lines, "Planning Prompt", [asString(artifactPlan?.intent) ?? promptSummary].filter((item): item is string => Boolean(item)));
  }

  if (plannerSummary && plannerSummary !== summary && !hasUserFacingPlanSections(providerVisibleText)) {
    section(lines, "Planner Summary", [plannerSummary]);
  }
  if (hasUserFacingPlanSections(providerVisibleText)) {
    section(lines, "Open Questions", questionLines(patch));
    section(lines, "Planning Prompt", [asString(artifactPlan?.intent) ?? promptSummary].filter((item): item is string => Boolean(item)));
  }
  section(lines, "Scope", scopeLines(asRecord(artifactPlan?.scope)));
  section(lines, "Commands Needed", asStringArray(artifactPlan?.commandsNeeded).map((item) => `- ${item}`));
  section(lines, "Tests Expected", asStringArray(artifactPlan?.testsExpected).map((item) => `- ${item}`));
  section(lines, "Allowed Roots", asStringArray(artifactPlan?.allowedRoots).map((item) => `- ${item}`));
  section(lines, "Rollback", [asString(artifactPlan?.rollbackNotes)].filter((item): item is string => Boolean(item)));

  const compact = lines.join("\n").trim();
  return compact || text.trim();
}
