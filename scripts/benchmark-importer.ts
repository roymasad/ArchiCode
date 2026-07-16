import path from "node:path";
import { runCodebaseImport } from "../src/main/importer/index";
import type { CodebaseImportDetail, CodebaseImportLevels } from "../src/main/importer/types";
import type { CodebaseMappingGranularity, Flow } from "../src/shared/schema";

const projectRoot = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!projectRoot) {
  console.error("Usage: npm run benchmark:importer -- /absolute/path/to/repo [levels] [detail] [granularity]");
  process.exit(1);
}

const levels = (["1", "2", "3", "4"].includes(process.argv[3]) ? process.argv[3] : "3") as CodebaseImportLevels;
const detail = (["light", "balanced", "deep"].includes(process.argv[4]) ? process.argv[4] : "balanced") as CodebaseImportDetail;
const granularity = (["system", "module", "component", "file"].includes(process.argv[5]) ? process.argv[5] : "component") as CodebaseMappingGranularity;
const summaryOnly = process.argv.includes("--summary");
const startedAt = Date.now();
const outcome = await runCodebaseImport({
  projectRoot,
  flowId: "flow-benchmark",
  levels,
  detail,
  granularity,
  codebaseHints: [],
  semanticEnabled: false,
  persistKnowledgeSnapshot: false
});

const evidenceNodes = outcome.operations.flatMap((operation) => operation.kind === "create-node" ? [operation.node] : []);
const perspectiveFlows = outcome.operations.flatMap((operation) => operation.kind === "create-flow" ? [operation.flow] : []);
const allFlows: Array<Pick<Flow, "id" | "nodes" | "edges" | "subflows" | "groups" | "perspective">> = [
  {
    id: "flow-benchmark",
    nodes: evidenceNodes.map((node, index) => ({ ...node, position: { x: index * 10, y: 0 }, updatedAt: "" })) as Flow["nodes"],
    edges: outcome.operations.flatMap((operation) => operation.kind === "create-edge" ? [operation.edge as Flow["edges"][number]] : []),
    subflows: outcome.operations.flatMap((operation) => operation.kind === "create-subflow" ? [operation.subflow as Flow["subflows"][number]] : []),
    groups: outcome.operations.flatMap((operation) => operation.kind === "create-group" ? [operation.group as Flow["groups"][number]] : []),
    perspective: undefined
  },
  ...perspectiveFlows
];
const subjectOccurrences = new Map<string, number>();
for (const flow of allFlows) {
  for (const node of flow.nodes) {
    if (node.subjectRef?.kind !== "code") continue;
    subjectOccurrences.set(node.subjectRef.id, (subjectOccurrences.get(node.subjectRef.id) ?? 0) + 1);
  }
}
const evidenceRelationKinds: Record<string, number> = {};
for (const edge of allFlows[0].edges) {
  for (const kind of edge.evidence?.relationKinds ?? []) evidenceRelationKinds[kind] = (evidenceRelationKinds[kind] ?? 0) + 1;
}

console.log(JSON.stringify({
  benchmarkVersion: 1,
  projectRoot,
  options: { levels, detail, granularity },
  elapsedMs: Date.now() - startedAt,
  repository: {
    filesScanned: outcome.stats.filesScanned,
    filesParsed: outcome.stats.filesParsed,
    fileEdges: outcome.stats.fileEdges,
    resolutionRate: outcome.stats.resolutionRate
  },
  evidenceFlow: {
    nodes: evidenceNodes.length,
    edges: allFlows[0].edges.length,
    subflows: allFlows[0].subflows.length,
    groups: allFlows[0].groups.length,
    relationKinds: evidenceRelationKinds,
    topLevelSubjects: evidenceNodes.filter((node) => !node.subflowId && node.id !== "node-project").map((node) => ({
      title: node.title,
      role: node.customProperties?.["Code role"] ?? "unknown"
    }))
  },
  perspectives: perspectiveFlows.map((flow) => ({
    id: flow.id,
    kind: flow.perspective?.kind,
    confidence: flow.perspective?.confidence,
    nodes: flow.nodes.length,
    edges: flow.edges.length,
    ...(summaryOnly ? {} : { subjects: flow.nodes.filter((node) => node.id !== "node-project").map((node) => node.title) }),
    coverage: flow.perspective?.coverage,
    limitations: flow.perspective?.limitations
  })),
  identity: {
    codeSubjects: subjectOccurrences.size,
    reusedAcrossFlows: [...subjectOccurrences.values()].filter((count) => count > 1).length,
    nodesMissingSubjectRef: allFlows.flatMap((flow) => flow.nodes).filter((node) => !node.subjectRef).length
  },
  quality: outcome.stats.quality,
  degraded: outcome.stats.degraded
}, null, 2));
