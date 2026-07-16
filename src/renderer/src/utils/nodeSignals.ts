import type { ProjectBundle } from "@shared/schema";

export type NodeSignalCounts = {
  notes: number;
  pinnedNotes: number;
  openQuestions: number;
  attachments: number;
  policyViolations: number;
};

export type OpenQuestionItem = {
  noteId: string;
  nodeId: string;
  nodeTitle: string;
  body: string;
};

export function nodePolicyViolationTooltip(count: number): string {
  return `${count} deterministic architecture violation${count === 1 ? "" : "s"}. Open the architecture issues button for details.`;
}

export function getNodeSignalCounts(bundle: ProjectBundle | null, nodeId: string, flowId?: string): NodeSignalCounts {
  if (!bundle) return { notes: 0, pinnedNotes: 0, openQuestions: 0, attachments: 0, policyViolations: 0 };
  const notes = bundle.notes.filter((note) => note.nodeId === nodeId && (!flowId || note.flowId === flowId));
  const visibleNotes = notes.filter((note) => note.kind !== "system-note" && note.author !== "system");
  return {
    notes: visibleNotes.length,
    pinnedNotes: notes.filter((note) => note.pinned).length,
    openQuestions: notes.filter((note) => note.kind === "llm-question" && !note.resolved).length,
    attachments: bundle.artifacts.filter((artifact) => artifact.nodeId === nodeId && artifact.type === "attachment").length,
    policyViolations: (bundle.policyEvaluation?.violations ?? []).filter((violation) =>
      (violation.source.nodeId === nodeId && (!flowId || violation.source.flowId === flowId)) ||
      (violation.target?.nodeId === nodeId && (!flowId || violation.target.flowId === flowId))
    ).length
  };
}

export function getOpenQuestionsForScope(
  bundle: ProjectBundle | null,
  flowId: string | null,
  nodeId?: string,
  subflowId?: string | null
): OpenQuestionItem[] {
  if (!bundle || !flowId) return [];
  const flow = bundle.flows.find((item) => item.id === flowId);
  if (!flow) return [];
  const nodeIds = new Set(
    nodeId
      ? [nodeId]
      : flow.nodes.filter((node) => !subflowId || node.subflowId === subflowId).map((node) => node.id)
  );
  const nodeTitleById = new Map(flow.nodes.map((node) => [node.id, node.title]));
  return bundle.notes
    .filter((note) =>
      note.flowId === flowId &&
      nodeIds.has(note.nodeId) &&
      note.kind === "llm-question" &&
      !note.resolved
    )
    .map((note) => ({
      noteId: note.id,
      nodeId: note.nodeId,
      nodeTitle: nodeTitleById.get(note.nodeId) ?? note.nodeId,
      body: note.body
    }));
}
