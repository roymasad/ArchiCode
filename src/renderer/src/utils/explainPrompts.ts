import type { ArchicodeNode, ArchitecturePolicyViolation, Artifact, Run } from "@shared/schema";

const readOnlyExplanationInstruction =
  "This is a read-only explanation. Do not edit the graph, prepare a graph change set, queue a run, or change source files. Discuss the item with me in chat so I can follow up.";

export function explainNodesPrompt(nodes: ArchicodeNode[], flowName: string): string {
  const selection = nodes.map((node) => `@${node.title}`).join(", ");
  return [
    `AI / Explain ${nodes.length === 1 ? "This Node" : "These Nodes"}: ${selection}.`,
    "",
    `Explain the selected node${nodes.length === 1 ? "" : "s"} in the context of flow "${flowName}".`,
    "Cover purpose, responsibilities, inputs and outputs, incoming and outgoing relationships, linked detail flows, rules, acceptance criteria, implementation evidence, current status, and important risks or unknowns.",
    nodes.length > 1 ? "Also explain how the selected nodes differ, interact, or overlap." : "Use exact neighboring node and edge names when describing relationships.",
    "",
    readOnlyExplanationInstruction
  ].join("\n");
}

export function explainEdgePrompt(input: {
  edgeId: string;
  flowName: string;
  sourceTitle: string;
  targetTitle: string;
  label?: string;
}): string {
  return [
    `AI / Explain This Edge: "${input.sourceTitle}" → "${input.targetTitle}".`,
    "",
    `Inspect edge ${input.edgeId} in flow "${input.flowName}"${input.label ? `, labelled "${input.label}"` : ""}.`,
    "Explain what the relationship means in this project, why its direction and label make sense, what evidence supports it, how each endpoint participates, and any ambiguity, risk, or missing context.",
    "",
    readOnlyExplanationInstruction
  ].join("\n");
}

export function explainFilePrompt(path: string): string {
  return [
    `AI / Explain This File: ${path}.`,
    "",
    "Inspect the current file contents and relevant project context. Explain its purpose, major symbols and behavior, callers and dependencies, related graph nodes or flows, current Git changes when present, and important risks, assumptions, or surprising details.",
    "Use concrete symbol names and source evidence, but keep the explanation understandable to someone navigating the project.",
    "",
    readOnlyExplanationInstruction
  ].join("\n");
}

export function explainRunPrompt(run: Run): string {
  return [
    `AI / Explain This Run: ${run.id}.`,
    "",
    `Inspect the stored run, logs, plan, artifacts, source diffs, verification evidence, questions, and errors. The run is currently "${run.status}" in phase "${run.phase}" and was started for: ${run.promptSummary}`,
    "Explain the objective, what actually happened, important decisions and changes, why it reached its current outcome, what remains unresolved, and the safest next step. Clearly separate evidence from inference.",
    "",
    readOnlyExplanationInstruction
  ].join("\n");
}

export function explainArtifactPrompt(artifact: Artifact): string {
  return [
    `AI / Explain This Artifact: ${artifact.title}.`,
    "",
    `Read artifact ${artifact.id} at "${artifact.path}". It is a ${artifact.type} artifact${artifact.runId ? ` from run ${artifact.runId}` : ""}${artifact.nodeId ? ` linked to node ${artifact.nodeId}` : ""}.`,
    "Explain why it exists, what its contents mean, the most important evidence or decisions it contains, how it relates to the project graph or run history, and anything the user should review or act on.",
    "",
    readOnlyExplanationInstruction
  ].join("\n");
}

function violationEndpoint(endpoint: ArchitecturePolicyViolation["source"] | undefined): string {
  if (!endpoint) return "none";
  const location = `${endpoint.path}${endpoint.line ? `:${endpoint.line}` : ""}`;
  return endpoint.nodeId ? `${location} (node ${endpoint.nodeId})` : location;
}

export function explainPolicyViolationsPrompt(
  violations: ArchitecturePolicyViolation[],
  nodeTitle?: string
): string {
  const findingLines = violations.map((violation, index) => [
    `${index + 1}. ${violation.policyTitle} · ${violation.severity} · ${violation.enforcement}`,
    `   ${violation.message}`,
    `   Source: ${violationEndpoint(violation.source)}`,
    `   Target: ${violationEndpoint(violation.target)}`
  ].join("\n"));
  return [
    `AI / Explain ${violations.length === 1 ? "Violation" : `${violations.length} Violations`}${nodeTitle ? ` for "${nodeTitle}"` : ""} and Suggest Resolution.`,
    "",
    "Explain each deterministic architecture-policy violation in plain language. Describe what the rule protects, the concrete evidence that triggered it, likely impact, whether it can block a source-changing run, and any uncertainty.",
    "Then suggest focused resolution options with tradeoffs and identify which graph, rule, or source-code area would need attention. Do not assume the rule or the code is automatically wrong.",
    "",
    ...findingLines,
    "",
    readOnlyExplanationInstruction
  ].join("\n");
}
