export type LogicReviewTarget =
  | { kind: "flow"; name: string }
  | { kind: "project"; name: string };

export function buildLogicReviewPrompt(target: LogicReviewTarget): string {
  const targetLabel = target.kind === "flow"
    ? `the current flow "${target.name}", including its root canvas and linked detail flows`
    : `all flows in the project "${target.name}", including their detail flows and cross-flow boundaries`;

  return [
    `AI / Review Flow Logic — ${target.kind === "flow" ? "Current Flow" : "All Project Flows"}.`,
    "",
    "Perform a read-only logic, coherence, and completeness review of the ArchiCode graph.",
    `Scope: ${targetLabel}.`,
    "",
    "Check for:",
    "- Nodes, requirements, acceptance criteria, notes, or flow responsibilities that contradict one another.",
    "- Missing information, decisions, actors, steps, states, data, error paths, dependencies, or ownership needed for the design to make sense.",
    "- Disconnected, redundant, ambiguous, or misplaced nodes and detail flows.",
    "- Edges whose direction, label, sequence, source, or target does not make logical sense, plus important relationships that are missing.",
    "- Flow boundaries, handoffs, inputs, outputs, and lifecycle transitions that are unclear or inconsistent.",
    ...(target.kind === "project"
      ? ["- Duplicated or conflicting responsibilities, terminology, assumptions, and handoffs across different project flows."]
      : []),
    "",
    "Return a prioritized report grouped into contradictions, missing information, and structural or connection issues. For each finding, name the exact flow and node(s), identify any relevant edge as source → target with its label, explain the impact, and suggest a focused question or possible correction. Explicitly say when a category has no findings.",
    "",
    "Do not edit the graph, prepare a graph change set, queue an agent run, or change source files. Discuss the findings with me in this chat so I can follow up before deciding what to change."
  ].join("\n");
}
