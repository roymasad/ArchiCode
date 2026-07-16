import { z } from "zod";
import type { Flow, GraphEdgeEvidence } from "../../shared/schema";
import { projectStatePath, readJson, writeJson } from "./persistence";

const graphEvidenceObservationSchema = z.object({
  checkedAt: z.string().datetime().optional(),
  freshness: z.enum(["current", "stale", "unknown"]).optional()
});

const graphEvidenceLocalStateSchema = z.object({
  version: z.literal(1),
  flows: z.record(z.record(graphEvidenceObservationSchema)).default({})
});

type GraphEvidenceObservation = z.infer<typeof graphEvidenceObservationSchema>;
type GraphEvidenceLocalState = z.infer<typeof graphEvidenceLocalStateSchema>;

const LOCAL_EVIDENCE_FILE = "graph-evidence-state.json";

function localEvidencePath(projectRoot: string): string {
  return projectStatePath(projectRoot, "runtime", LOCAL_EVIDENCE_FILE);
}

async function readLocalEvidence(projectRoot: string): Promise<GraphEvidenceLocalState> {
  const raw = await readJson<unknown>(localEvidencePath(projectRoot), null);
  const parsed = graphEvidenceLocalStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : { version: 1, flows: {} };
}

function observation(evidence: GraphEdgeEvidence | undefined): GraphEvidenceObservation | undefined {
  if (!evidence?.checkedAt && (!evidence?.freshness || evidence.freshness === "unknown")) return undefined;
  return {
    ...(evidence.checkedAt ? { checkedAt: evidence.checkedAt } : {}),
    ...(evidence.freshness ? { freshness: evidence.freshness } : {})
  };
}

function newerObservation(left: GraphEvidenceObservation | undefined, right: GraphEvidenceObservation | undefined): GraphEvidenceObservation | undefined {
  if (!left) return right;
  if (!right) return left;
  const leftTime = left.checkedAt ? Date.parse(left.checkedAt) : 0;
  const rightTime = right.checkedAt ? Date.parse(right.checkedAt) : 0;
  return rightTime >= leftTime ? { ...left, ...right } : { ...right, ...left };
}

export async function rememberGraphEvidenceLocalState(projectRoot: string, flows: Flow[]): Promise<void> {
  const current = await readLocalEvidence(projectRoot);
  const next: GraphEvidenceLocalState = { version: 1, flows: { ...current.flows } };
  for (const flow of flows) {
    const observations: Record<string, GraphEvidenceObservation> = {};
    for (const edge of flow.edges) {
      const value = observation(edge.evidence);
      if (value) observations[edge.id] = value;
    }
    next.flows[flow.id] = observations;
  }
  if (JSON.stringify(next) !== JSON.stringify(current)) await writeJson(localEvidencePath(projectRoot), next);
}

export async function rememberGraphEvidenceForFlow(
  projectRoot: string,
  flowId: string,
  edges: Array<Pick<Flow["edges"][number], "id" | "evidence">>
): Promise<void> {
  await rememberGraphEvidenceForFlows(projectRoot, [{ flowId, edges }]);
}

/** Persist evidence observations for several independent flows with one read/write. */
export async function rememberGraphEvidenceForFlows(
  projectRoot: string,
  flowEvidence: Array<{
    flowId: string;
    edges: Array<Pick<Flow["edges"][number], "id" | "evidence">>;
  }>
): Promise<void> {
  const current = await readLocalEvidence(projectRoot);
  const flows = { ...current.flows };
  for (const { flowId, edges } of flowEvidence) {
    const observations: Record<string, GraphEvidenceObservation> = {};
    for (const edge of edges) {
      const value = observation(edge.evidence);
      if (value) observations[edge.id] = value;
    }
    flows[flowId] = observations;
  }
  const next: GraphEvidenceLocalState = {
    version: 1,
    flows
  };
  if (JSON.stringify(next) !== JSON.stringify(current)) await writeJson(localEvidencePath(projectRoot), next);
}

export async function hydrateGraphEvidenceLocalState(projectRoot: string, flows: Flow[]): Promise<Flow[]> {
  const current = await readLocalEvidence(projectRoot);
  let migrated = false;
  const next: GraphEvidenceLocalState = { version: 1, flows: { ...current.flows } };
  const hydrated = flows.map((flow) => ({
    ...flow,
    edges: flow.edges.map((edge) => {
      if (!edge.evidence) return edge;
      const inline = observation(edge.evidence);
      const saved = current.flows[flow.id]?.[edge.id];
      const merged = newerObservation(saved, inline);
      if (inline && JSON.stringify(saved) !== JSON.stringify(merged)) {
        next.flows[flow.id] = { ...(next.flows[flow.id] ?? {}), [edge.id]: merged! };
        migrated = true;
      }
      return merged ? { ...edge, evidence: { ...edge.evidence, ...merged } } : edge;
    })
  }));
  // One-time migration preserves volatile values from older shared flow files
  // locally. The shared file is only cleaned on its next intentional write.
  if (migrated) await writeJson(localEvidencePath(projectRoot), next);
  return hydrated;
}
