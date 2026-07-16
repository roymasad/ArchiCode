import { createHash } from "node:crypto";
import {
  archicodeNodeSchema,
  flowEdgeSchema,
  flowGroupSchema,
  flowSchema,
  type ArchicodeNode,
  type Flow,
  type ResearchGraphOperation
} from "../../shared/schema";
import { subjectRefForCluster } from "./emit";
import {
  clusterHasDurablePersistenceEvidence,
  graphHasDurablePersistenceEvidence,
  normalizeProjectionSemanticScope,
  normalizeSemanticLensClaim,
  normalizeTransientDataEdgeLabel,
  semanticTerms
} from "./semanticTruth";
import type { ArchitectureLensPlan, GraphProjection, ModuleCluster, ModuleGraph } from "./types";

const TYPE_FALLBACK: Record<ArchitectureLensPlan["id"], string> = {
  functional: "capability",
  "user-journey": "journey-step",
  data: "data-owner",
  infrastructure: "deployable"
};

const EDGE_KIND: Record<ArchitectureLensPlan["id"], string> = {
  functional: "capability-flow",
  "user-journey": "user-flow",
  data: "data-flow",
  infrastructure: "delivery-flow"
};

const COLOR: Record<ArchitectureLensPlan["id"], string> = {
  functional: "#4f83cc",
  "user-journey": "#9a7fc4",
  data: "#5fa88a",
  infrastructure: "#b8875f"
};

export type LensCompilationDiagnostics = {
  lensId: ArchitectureLensPlan["id"];
  status: "compiled" | "missing-plan" | "rejected";
  planProvided: boolean;
  proposedNodes: number;
  resolvedNodes: number;
  emittedNodes: number;
  proposedEdges: number;
  emittedEdges: number;
  droppedNodes: Array<{ id: string; reason: string }>;
  droppedEdges: Array<{ source: string; target: string; reason: string }>;
  normalizedTypes: Array<{ nodeId: string; supplied: string; canonical: string }>;
  issues: string[];
  repairAttempted?: boolean;
  fallbackUsed: boolean;
};

export type LensCompilationResult = {
  flow: Flow | null;
  diagnostics: LensCompilationDiagnostics;
};

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "lens-node";
}

function cleanMember(value: string): string | null {
  const clean = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!clean || clean === "." || clean === ".." || clean.startsWith("../") || clean.startsWith("/")) return null;
  return clean;
}

function evidenceForMember(member: string, graph: ModuleGraph, knownFiles: Set<string>): { paths: string[]; clusters: ModuleCluster[] } {
  const clean = cleanMember(member);
  if (!clean) return { paths: [], clusters: [] };
  const exact = knownFiles.has(clean);
  const paths = exact ? [clean] : [...knownFiles].filter((file) => file.startsWith(`${clean}/`)).slice(0, 12);
  if (!paths.length) return { paths: [], clusters: [] };
  const candidates = graph.clusters
    .filter((cluster) => paths.some((file) => (cluster.ownedFiles ?? cluster.files).includes(file)))
    .sort((left, right) => right.tier - left.tier || left.files.length - right.files.length);
  // Exact files resolve to one narrow canonical anchor. A directory may span a
  // few independent responsibilities, so retain a bounded representative set
  // without copying that whole code subtree into the lens.
  return { paths, clusters: candidates.slice(0, exact ? 1 : 4) };
}

export function semanticType(plan: ArchitectureLensPlan, type: string, contextOnly: boolean): string {
  const normalized = slug(type);
  if (contextOnly && plan.id === "user-journey") return /actor|persona|customer|operator|visitor|user/.test(normalized) ? "actor" : "context-note";
  if (plan.id === "functional") return "capability";
  if (plan.id === "user-journey") {
    if (/actor|persona|customer|operator|visitor|user/.test(normalized)) return "actor";
    if (/trigger|initiat|start|entry/.test(normalized)) return "trigger";
    if (/decision|choice|branch|gate/.test(normalized)) return "decision";
    if (/outcome|result|success|failure|completion|end-state/.test(normalized)) return "outcome";
    return "journey-step";
  }
  if (plan.id === "data") {
    if (/^(data-owner|data-state|data-store|data-entity|data-transform|data-sync|migration)$/.test(normalized)) return normalized;
    if (/migration|schema-change/.test(normalized)) return "migration";
    if (/sync|backup|replicat|transfer|movement|import|export/.test(normalized)) return "data-sync";
    if (/transform|project|derive|normaliz|validat|aggregate|mapping|mapper|projection/.test(normalized)) return "data-transform";
    if (/state|session|memory|in-memory|transient/.test(normalized)) return "data-state";
    if (/store|storage|database|repository|ledger|cache|persist|file/.test(normalized)) return "data-store";
    if (/entity|record|model|schema|document|payload/.test(normalized)) return "data-entity";
    return "data-owner";
  }
  if (plan.id === "infrastructure") {
    if (/^(delivery-automation|build-artifact|deployable|hosting|managed-resource|external-boundary)$/.test(normalized)) return normalized;
    if (/artifact|package|image|bundle|build-output|release/.test(normalized)) return "build-artifact";
    if (/pipeline|workflow|ci-cd|automation|deploy-job|build-job/.test(normalized) || normalized === "build" || normalized === "deploy") return "delivery-automation";
    if (/external|boundary|third-party|provider|managed-service/.test(normalized)) return "external-boundary";
    if (/hosting|host|platform/.test(normalized)) return "hosting";
    if (/resource|database|bucket|queue|topic|secret|storage|network/.test(normalized)) return "managed-resource";
    return "deployable";
  }
  return TYPE_FALLBACK[plan.id];
}

function edgeLabelIsUseful(value: string): boolean {
  const label = value.trim();
  return label.length >= 3
    && !/^(?:imports?|depends? on|dependency|uses?|connects? to|relates? to)$/i.test(label)
    // Lens labels are rendered between source and target, so directional phrases
    // such as "deploys to" and "is persisted by" are complete and useful here.
    && !/\b(?:and|or)$/i.test(label);
}

function distinctBehavioralContracts(contracts: NonNullable<GraphProjection["behavioralContracts"]>, limit: number): NonNullable<GraphProjection["behavioralContracts"]> {
  const genericTerms = new Set(["ask", "user", "users", "order", "reply", "show", "share", "tell", "write", "when", "after", "before", "confirm", "confirmed", "confirmation"]);
  const selected: NonNullable<GraphProjection["behavioralContracts"]> = [];
  for (const contract of contracts) {
    const terms = new Set(contract.terms.filter((term) => !genericTerms.has(term)));
    const overlaps = selected.some((candidate) => {
      const other = new Set(candidate.terms.filter((term) => !genericTerms.has(term)));
      const intersection = [...terms].filter((term) => other.has(term)).length;
      return intersection >= 2 && intersection / Math.max(1, Math.min(terms.size, other.size)) >= 0.5;
    });
    if (!overlaps) selected.push(contract);
    if (selected.length >= limit) break;
  }
  return selected;
}

function contractCovered(contract: NonNullable<GraphProjection["behavioralContracts"]>[number], nodes: Array<{ title: string; description: string }>): boolean {
  const terms = semanticTerms(contract.text);
  return nodes.some((node) => {
    const nodeTerms = semanticTerms(`${node.title} ${node.description}`);
    const overlap = [...terms].filter((term) => nodeTerms.has(term)).length;
    return overlap >= Math.min(2, Math.max(1, terms.size));
  });
}

/** Evidence-bounded fallback for weak/no-provider Product and Journey plans. */
export function deterministicContractLensPlan(projection: GraphProjection, lensId: ArchitectureLensPlan["id"]): ArchitectureLensPlan | null {
  const contracts = projection.behavioralContracts ?? [];
  if (lensId === "functional") {
    const productContracts = contracts.filter((contract) => contract.kind !== "journey-step" && contract.kind !== "decision");
    const selected = distinctBehavioralContracts(productContracts.length >= 2 ? productContracts : contracts, 8);
    if (selected.length < 2) return null;
    return {
      id: "functional",
      nodes: selected.map((contract, index) => ({
        id: `observed-capability-${index + 1}-${slug(contract.title)}`,
        title: contract.title,
        type: "capability",
        description: `Repository-declared product behavior: ${contract.text}`,
        evidenceMembers: [contract.file],
        groupName: "Observed Product Behavior"
      })),
      edges: []
    };
  }
  if (lensId !== "user-journey") return null;
  const byFile = new Map<string, typeof contracts>();
  const journeyContracts = contracts.filter((contract) => contract.kind === "journey-step" || contract.kind === "decision");
  for (const contract of journeyContracts.length >= 3 ? journeyContracts : contracts) {
    const list = byFile.get(contract.file) ?? [];
    list.push(contract);
    byFile.set(contract.file, list);
  }
  const sequence = [...byFile.values()]
    .sort((left, right) => right.length - left.length)[0]
    ?.sort((left, right) => left.sequence - right.sequence);
  if (!sequence || sequence.length < 3) return null;
  const steps = distinctBehavioralContracts(sequence, 12).sort((left, right) => left.sequence - right.sequence);
  if (steps.length < 3) return null;
  const nodes: ArchitectureLensPlan["nodes"] = [{
    id: "observed-user",
    title: "User",
    type: "actor",
    description: "The user participating in ordered behavior declared by repository prompts, policies, or workflow evidence.",
    evidenceMembers: [],
    contextOnly: true
  }, ...steps.map((contract, index) => ({
    id: `observed-step-${index + 1}-${slug(contract.title)}`,
    title: contract.title,
    type: index === 0 ? "trigger" : index === steps.length - 1 ? "outcome" : contract.kind === "decision" ? "decision" : "journey-step",
    description: `Repository-declared journey behavior: ${contract.text}`,
    evidenceMembers: [contract.file]
  }))];
  return {
    id: "user-journey",
    nodes,
    edges: nodes.slice(1).map((target, index) => ({
      source: nodes[index].id,
      target: target.id,
      label: index === 0 ? `initiates ${target.title.toLowerCase()}` : `then advances to ${target.title.toLowerCase()}`
    }))
  };
}

/**
 * Turn a provider-authored mental model into an evidence-bounded flow. The
 * resulting concepts are lens-local interpretations; canonical code identity
 * remains in the evidence flow and is referenced through custom properties.
 */
function connectedComponents(nodeIds: string[], pairs: Array<{ source: string; target: string }>): number[][] {
  const index = new Map(nodeIds.map((id, itemIndex) => [id, itemIndex]));
  const adjacency = nodeIds.map(() => new Set<number>());
  for (const pair of pairs) {
    const source = index.get(pair.source);
    const target = index.get(pair.target);
    if (source === undefined || target === undefined) continue;
    adjacency[source].add(target);
    adjacency[target].add(source);
  }
  const seen = new Set<number>();
  const components: number[][] = [];
  for (let start = 0; start < nodeIds.length; start += 1) {
    if (seen.has(start)) continue;
    const pending = [start];
    const component: number[] = [];
    seen.add(start);
    while (pending.length) {
      const current = pending.pop() as number;
      component.push(current);
      for (const neighbor of adjacency[current]) if (!seen.has(neighbor)) {
        seen.add(neighbor);
        pending.push(neighbor);
      }
    }
    components.push(component);
  }
  return components.sort((left, right) => right.length - left.length);
}

function compiledLensIssues(plan: ArchitectureLensPlan, nodes: ArchicodeNode[], edges: Flow["edges"]): string[] {
  const issues: string[] = [];
  const ids = nodes.map((node) => node.id);
  const components = connectedComponents(ids, edges);
  const connectedIds = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  const isolated = nodes.filter((node) => !connectedIds.has(node.id)).length;
  if (nodes.length < 2) issues.push("fewer than two evidence-resolved lens nodes remain");
  // A capability map may truthfully contain independent outcomes. Journey,
  // data, and infrastructure flows still require connective structure.
  if (plan.id !== "functional") {
    if (edges.length < Math.max(1, nodes.length - 2)) issues.push(`only ${edges.length}/${Math.max(1, nodes.length - 2)} minimum coherent relationships survived compilation`);
    if ((components[0]?.length ?? 0) < Math.max(2, nodes.length - 1)) issues.push("the compiled flow is split into disconnected islands");
  }

  if (plan.id === "functional") {
    const capabilityCount = nodes.filter((node) => node.type === "capability").length;
    if (capabilityCount < Math.max(2, Math.ceil(nodes.length / 2))) issues.push("compiled subjects are not predominantly product capabilities");
  }
  if (plan.id === "user-journey") {
    const types = new Set(nodes.map((node) => node.type));
    const ordered = nodes.filter((node) => /^(trigger|journey-step|decision|outcome)$/.test(node.type)).length;
    if (!types.has("actor")) issues.push("the compiled journey has no actor");
    if (!types.has("outcome")) issues.push("the compiled journey has no outcome");
    if (ordered < 2) issues.push("the compiled journey lacks ordered trigger, step, decision, or outcome roles");
    if (components.length !== 1 || edges.length < Math.max(1, nodes.length - 1)) issues.push("the compiled journey is not one connected ordered path");
  }
  if (plan.id === "data") {
    const roles = new Set(nodes.flatMap((node) => {
      if (node.type === "data-owner") return ["owner"];
      if (node.type === "data-entity") return ["entity"];
      if (node.type === "data-store" || node.type === "data-state") return ["store"];
      if (node.type === "data-transform") return ["transform"];
      if (node.type === "data-sync" || node.type === "migration") return ["movement"];
      return [];
    }));
    const requiredRoles = nodes.length >= 6 ? 3 : 2;
    if (roles.size < requiredRoles) issues.push(`compiled data roles collapse to ${roles.size}/${requiredRoles} required owner/entity/store/transform/movement roles`);
    if (nodes.length >= 4 && isolated > Math.max(1, Math.floor(nodes.length * 0.2))) issues.push(`${isolated}/${nodes.length} compiled data subjects are isolated`);
  }
  if (plan.id === "infrastructure") {
    const roles = new Set(nodes.flatMap((node) => {
      if (node.type === "delivery-automation") return ["delivery"];
      if (node.type === "build-artifact") return ["artifact"];
      if (node.type === "deployable" || node.type === "hosting" || node.type === "managed-resource") return ["runtime"];
      if (node.type === "external-boundary") return ["boundary"];
      return [];
    }));
    const requiredRoles = nodes.length >= 6 ? 3 : 2;
    if (roles.size < requiredRoles) issues.push(`compiled infrastructure roles collapse to ${roles.size}/${requiredRoles} required delivery/artifact/runtime/boundary roles`);
    if (nodes.length >= 4 && isolated > Math.max(1, Math.floor(nodes.length * 0.2))) issues.push(`${isolated}/${nodes.length} compiled infrastructure subjects are isolated`);
  }
  return [...new Set(issues)];
}

export function compileLensPlan(input: {
  fallbackFlow: Flow;
  projection: GraphProjection;
  plan: ArchitectureLensPlan;
  graph: ModuleGraph;
  checkedAt: string;
}): LensCompilationResult {
  const diagnostics: LensCompilationDiagnostics = {
    lensId: input.plan.id,
    status: "rejected",
    planProvided: true,
    proposedNodes: input.plan.nodes.length,
    resolvedNodes: 0,
    emittedNodes: 0,
    proposedEdges: input.plan.edges.length,
    emittedEdges: 0,
    droppedNodes: [],
    droppedEdges: [],
    normalizedTypes: [],
    issues: [],
    fallbackUsed: true
  };
  if (input.plan.id !== input.projection.id) {
    diagnostics.issues.push(`plan id ${input.plan.id} does not match projection ${input.projection.id}`);
    return { flow: null, diagnostics };
  }
  const knownFiles = new Set(input.graph.clusters.flatMap((cluster) => cluster.files));
  const projectNode = input.fallbackFlow.nodes.find((node) => node.id === "node-project");
  if (!projectNode) {
    diagnostics.issues.push("project context node was unavailable");
    return { flow: null, diagnostics };
  }
  const planNodes = new Map<string, {
    node: ArchicodeNode;
    sourcePaths: string[];
    anchorIds: string[];
    groupName?: string;
  }>();
  for (const candidate of input.plan.nodes) {
    const contextOnly = Boolean(candidate.contextOnly && input.plan.id === "user-journey");
    const evidence = candidate.evidenceMembers.map((member) => evidenceForMember(member, input.graph, knownFiles));
    const sourcePaths = [...new Set(evidence.flatMap((item) => item.paths))];
    const anchorClusters = [...new Map(evidence.flatMap((item) => item.clusters).map((cluster) => [cluster.id, cluster])).values()];
    const anchorIds = anchorClusters.map((cluster) => subjectRefForCluster(cluster).id).sort();
    if (!contextOnly && !anchorIds.length) {
      diagnostics.droppedNodes.push({ id: candidate.id, reason: "no evidenceMembers resolved to canonical code subjects" });
      continue;
    }
    const nodeId = `node-lens-${slug(candidate.id)}`;
    if (planNodes.has(candidate.id) || [...planNodes.values()].some((item) => item.node.id === nodeId)) {
      diagnostics.droppedNodes.push({ id: candidate.id, reason: "duplicate provider id after normalization" });
      continue;
    }
    const fingerprint = createHash("sha256")
      .update([input.plan.id, candidate.id, ...anchorIds].join("\n"))
      .digest("hex")
      .slice(0, 20);
    let type = semanticType(input.plan, candidate.type, contextOnly);
    if (input.plan.id === "data" && type === "data-store" && !anchorClusters.some(clusterHasDurablePersistenceEvidence)) type = "data-state";
    if (slug(candidate.type) !== type) diagnostics.normalizedTypes.push({ nodeId: candidate.id, supplied: candidate.type, canonical: type });
    const semanticClaim = normalizeSemanticLensClaim({
      lensId: input.plan.id,
      projection: input.projection,
      title: candidate.title,
      description: candidate.description,
      type,
      sourcePaths,
      anchorClusters
    });
    const techStack = [...new Set(anchorClusters.flatMap((cluster) => [...cluster.languages, ...cluster.externalDeps.slice(0, 2)]))].slice(0, 6);
    const shape = type === "actor" ? "capsule" : type === "data-store" || type === "managed-resource" ? "database" : type === "context-note" ? "note" : type.includes("artifact") ? "document" : "rounded";
    planNodes.set(candidate.id, {
      node: archicodeNodeSchema.parse({
        id: nodeId,
        type,
        title: semanticClaim.title,
        description: semanticClaim.description,
        stage: "draft-approved-production",
        ignored: false,
        flags: [],
        locked: false,
        visual: { shape, backgroundColor: COLOR[input.plan.id] },
        position: { x: 120 + (planNodes.size % 4) * 340, y: 150 + Math.floor(planNodes.size / 4) * 230 },
        techStack,
        acceptanceCriteria: [],
        acceptanceChecks: [],
        subjectRef: {
          id: `${contextOnly ? "context" : "concept"}:${input.plan.id}:${fingerprint}`,
          kind: contextOnly ? "context-note" : "concept",
          evidenceStatus: contextOnly ? "context" : "inferred",
          scopeFingerprint: fingerprint
        },
        customProperties: {
          "Lens role": type,
          "Canonical code anchors": anchorIds.join(", ") || "none — context only",
          "Evidence paths": sourcePaths.slice(0, 12).join(", ") || "none — context only",
          "Evidence status": contextOnly ? "Context only; not claimed as repository implementation" : "Architectural interpretation grounded in canonical code subjects",
          "Claim basis": semanticClaim.status,
          ...(input.plan.id === "data" ? { "Storage durability": semanticClaim.status === "implemented-durable" ? "Concrete durable sink observed" : "No durable sink observed; transient, declared, or conceptual only" } : {}),
          ...(semanticClaim.relevantContracts.length ? { "Declared behavior evidence": semanticClaim.relevantContracts.map((contract) => `${contract.file}:${contract.line}`).join(", ") } : {}),
          ...(semanticClaim.corrections.length ? { "Semantic safeguards": semanticClaim.corrections.join(" ") } : {}),
          "Interpretation boundary": "This lens concept explains the codebase from one mental perspective; it does not replace canonical code ownership"
        },
        attachments: [],
        todos: [],
        updatedAt: input.checkedAt
      }),
      sourcePaths,
      anchorIds,
      groupName: candidate.groupName
    });
  }
  if (input.plan.id === "functional") {
    const existingConcepts = [...planNodes.values()].map((item) => ({ title: item.node.title, description: item.node.description }));
    const uncovered = distinctBehavioralContracts(input.projection.behavioralContracts ?? [], 8)
      .filter((contract) => !contractCovered(contract, existingConcepts));
    for (const contract of uncovered) {
      if (planNodes.size >= 12) break;
      const evidence = evidenceForMember(contract.file, input.graph, knownFiles);
      const anchorIds = evidence.clusters.map((cluster) => subjectRefForCluster(cluster).id).sort();
      if (!anchorIds.length) continue;
      const candidateId = `observed-contract-${contract.line}-${slug(contract.title)}`;
      if (planNodes.has(candidateId)) continue;
      const fingerprint = createHash("sha256")
        .update([input.plan.id, candidateId, ...anchorIds].join("\n"))
        .digest("hex")
        .slice(0, 20);
      planNodes.set(candidateId, {
        node: archicodeNodeSchema.parse({
          id: `node-lens-${slug(candidateId)}`,
          type: "capability",
          title: contract.title,
          description: `Repository-declared product behavior: ${contract.text}`,
          stage: "draft-approved-production",
          ignored: false,
          flags: [],
          locked: false,
          visual: { shape: "rounded", backgroundColor: COLOR.functional },
          position: { x: 120 + (planNodes.size % 4) * 340, y: 150 + Math.floor(planNodes.size / 4) * 230 },
          techStack: [],
          acceptanceCriteria: [],
          acceptanceChecks: [],
          subjectRef: { id: `concept:functional:${fingerprint}`, kind: "concept", evidenceStatus: "inferred", scopeFingerprint: fingerprint },
          customProperties: {
            "Lens role": "capability",
            "Canonical code anchors": anchorIds.join(", "),
            "Evidence paths": contract.file,
            "Evidence line": String(contract.line),
            "Evidence status": "Architectural interpretation grounded in repository-declared behavioral evidence",
            "Claim basis": contract.evidenceMode === "declared" ? "prompt-defined" : "evidence-bounded",
            "Interpretation boundary": "This lens concept explains product behavior without becoming canonical code ownership"
          },
          attachments: [],
          todos: [],
          updatedAt: input.checkedAt
        }),
        sourcePaths: [contract.file],
        anchorIds,
        groupName: "Observed Product Behavior"
      });
      existingConcepts.push({ title: contract.title, description: contract.text });
    }
  }
  diagnostics.resolvedNodes = planNodes.size;
  diagnostics.emittedNodes = planNodes.size;

  const groupNames = [...new Set([...planNodes.values()].flatMap((item) => item.groupName ? [item.groupName] : []))];
  const groups = groupNames.map((name, index) => flowGroupSchema.parse({ id: `group-${input.plan.id}-${index + 1}-${slug(name)}`, name, color: COLOR[input.plan.id] }));
  const groupByName = new Map(groups.map((group) => [group.name, group.id]));
  const nodes = [structuredClone(projectNode), ...[...planNodes.values()].map((item) => ({
    ...item.node,
    ...(item.groupName && groupByName.has(item.groupName) ? { groupId: groupByName.get(item.groupName) } : {})
  }))];
  const edgeIds = new Set<string>();
  const edges = input.plan.edges.flatMap((edge) => {
    const source = planNodes.get(edge.source);
    const target = planNodes.get(edge.target);
    if (!source || !target) {
      diagnostics.droppedEdges.push({ source: edge.source, target: edge.target, reason: "source or target was removed during evidence resolution" });
      return [];
    }
    if (source.node.id === target.node.id) {
      diagnostics.droppedEdges.push({ source: edge.source, target: edge.target, reason: "self relationship" });
      return [];
    }
    if (!edgeLabelIsUseful(edge.label)) {
      diagnostics.droppedEdges.push({ source: edge.source, target: edge.target, reason: "relationship label was generic or incomplete" });
      return [];
    }
    const baseId = `edge-lens-${slug(edge.source)}--${slug(edge.target)}`;
    if (edgeIds.has(baseId)) {
      diagnostics.droppedEdges.push({ source: edge.source, target: edge.target, reason: "duplicate relationship" });
      return [];
    }
    edgeIds.add(baseId);
    const locations = [...new Set([...source.sourcePaths, ...target.sourcePaths])].slice(0, 8).map((path) => ({ path }));
    const label = input.plan.id === "data" && !graphHasDurablePersistenceEvidence(input.graph, input.projection.clusterIds)
      ? normalizeTransientDataEdgeLabel(edge.label.trim())
      : edge.label.trim();
    return [flowEdgeSchema.parse({
      id: baseId,
      source: source.node.id,
      target: target.node.id,
      label,
      lineStyle: "dashed",
      evidence: {
        origin: "inferred",
        confidence: 0.6,
        relationKinds: [EDGE_KIND[input.plan.id]],
        locations,
        analyzerVersion: 1,
        checkedAt: input.checkedAt,
        verification: "ambiguous",
        freshness: "current"
      }
    })];
  });
  diagnostics.emittedEdges = edges.length;
  diagnostics.issues = compiledLensIssues(input.plan, [...planNodes.values()].map((item) => item.node), edges);
  if (diagnostics.issues.length) return { flow: null, diagnostics };

  const flow = flowSchema.parse({
    ...input.fallbackFlow,
    nodes,
    edges,
    subflows: [],
    groups,
    updatedAt: input.checkedAt,
    perspective: {
      ...input.fallbackFlow.perspective,
      confidence: "medium",
      evidenceBasis: [...new Set([...(input.fallbackFlow.perspective?.evidenceBasis ?? []), "provider-authored lens concepts grounded to canonical code subjects", "bounded repository architecture documents"])],
      limitations: [...new Set([...(input.fallbackFlow.perspective?.limitations ?? []), "Concept nodes are evidence-bounded architectural interpretations, not additional implementation sources of truth."])],
      coverage: {
        subjects: planNodes.size,
        relations: edges.length,
        observedRelations: 0,
        inferredRelations: edges.length
      }
    }
  });
  diagnostics.status = "compiled";
  diagnostics.fallbackUsed = false;
  return { flow, diagnostics };
}

export function flowFromLensPlan(input: Parameters<typeof compileLensPlan>[0]): Flow | null {
  return compileLensPlan(input).flow;
}

const PERSPECTIVE_LENS_ID: Partial<Record<NonNullable<Flow["perspective"]>["kind"], ArchitectureLensPlan["id"]>> = {
  "product-capabilities": "functional",
  "user-journeys": "user-journey",
  "data-persistence": "data",
  "cloud-infrastructure": "infrastructure"
};

function nodeEvidencePaths(node: ArchicodeNode): string[] {
  return (node.customProperties["Evidence paths"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value && value !== "none — context only");
}

/**
 * Reapply semantic truth boundaries after provider review. Reviewer patches may
 * improve prose, but they cannot upgrade a declared prompt or transient state
 * into a proven durable/external effect.
 */
export function enforceSemanticTruthOnAtlasOperations(
  operations: ResearchGraphOperation[],
  graph: ModuleGraph
): ResearchGraphOperation[] {
  const projectionById = new Map((graph.projections ?? []).map((projection) => [projection.id, projection]));
  return operations.map((operation) => {
    if (operation.kind !== "create-flow" || !operation.flow.perspective) return operation;
    const lensId = PERSPECTIVE_LENS_ID[operation.flow.perspective.kind];
    const rawProjection = lensId ? projectionById.get(lensId) : undefined;
    if (!lensId || !rawProjection) return operation;
    const projection = normalizeProjectionSemanticScope(rawProjection, graph);
    const flow = structuredClone(operation.flow);
    const perspective = flow.perspective;
    if (!perspective) return operation;
    if (lensId === "data" && projection.title !== rawProjection.title) {
      flow.name = projection.title;
      flow.description = projection.description;
      flow.perspective = {
        ...perspective,
        question: projection.question,
        evidenceBasis: projection.evidenceBasis,
        limitations: [...new Set([...perspective.limitations, "No durable persistence sink was observed; this flow depicts runtime state and declared data concepts without upgrading them to durable storage."])]
      };
      const projectNode = flow.nodes.find((node) => node.id === "node-project");
      if (projectNode) {
        projectNode.title = `${projectNode.title.replace(/\s+—\s+.*$/, "")} — ${projection.title}`;
        projectNode.description = `${projection.question} ${projection.description}`;
      }
    }
    flow.nodes = flow.nodes.map((node) => {
      if (node.id === "node-project" || (node.subjectRef?.kind !== "concept" && node.subjectRef?.kind !== "context-note")) return node;
      const sourcePaths = nodeEvidencePaths(node);
      const sourceSet = new Set(sourcePaths);
      const anchorClusters = graph.clusters.filter((cluster) => cluster.files.some((file) => sourceSet.has(file) || [...sourceSet].some((source) => file.startsWith(`${source}/`))));
      let type = node.type;
      if (lensId === "data" && type === "data-store" && !anchorClusters.some(clusterHasDurablePersistenceEvidence)) type = "data-state";
      const semanticClaim = normalizeSemanticLensClaim({
        lensId,
        projection,
        title: node.title,
        description: node.description,
        type,
        sourcePaths,
        anchorClusters
      });
      return archicodeNodeSchema.parse({
        ...node,
        type,
        title: semanticClaim.title,
        description: semanticClaim.description,
        visual: type === "data-state" ? { ...node.visual, shape: "rounded" } : node.visual,
        customProperties: {
          ...node.customProperties,
          "Claim basis": semanticClaim.status,
          ...(lensId === "data" ? { "Storage durability": semanticClaim.status === "implemented-durable" ? "Concrete durable sink observed" : "No durable sink observed; transient, declared, or conceptual only" } : {}),
          ...(semanticClaim.relevantContracts.length ? { "Declared behavior evidence": semanticClaim.relevantContracts.map((contract) => `${contract.file}:${contract.line}`).join(", ") } : {}),
          ...(semanticClaim.corrections.length ? { "Semantic safeguards": semanticClaim.corrections.join(" ") } : {})
        }
      });
    });
    if (lensId === "data" && !graphHasDurablePersistenceEvidence(graph, projection.clusterIds)) {
      flow.edges = flow.edges.map((edge) => ({
        ...edge,
        label: edge.label ? normalizeTransientDataEdgeLabel(edge.label) : edge.label
      }));
    }
    return { ...operation, flow: flowSchema.parse(flow) };
  });
}

export function semanticTruthSafeguardsForOperations(operations: ResearchGraphOperation[]): string[] {
  const flows = operations.flatMap((operation) => operation.kind === "create-flow" ? [operation.flow] : []);
  const correctedClaims = flows.flatMap((flow) => flow.nodes)
    .filter((node) => Boolean(node.customProperties["Semantic safeguards"])).length;
  const runtimeStateScope = flows.some((flow) => flow.perspective?.kind === "data-persistence" && flow.name === "Data Ownership & Runtime State");
  return [
    ...(correctedClaims ? [`Semantic truth safeguards reframed ${correctedClaims} provider-authored lens claim${correctedClaims === 1 ? "" : "s"} that lacked matching durable-storage or external-effect evidence.`] : []),
    ...(runtimeStateScope ? ["The data lens was scoped to runtime state because no concrete durable persistence sink was observed."] : [])
  ];
}
