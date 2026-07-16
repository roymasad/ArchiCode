import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  artifactSchema,
  contextManifestSchema,
  contextMemoryRecordSchema,
  estimateContextSize,
  isNoteActiveForModelContext,
  runScopeSchema
} from "../../shared/schema";
import type { Artifact, ContextLifecycle, ContextManifest, ContextMemoryRecord, Flow, GraphChangeRecord, Note, ProjectBundle, ProjectSettings, Run, RunContextSummary, RunScope } from "../../shared/schema";
import { isSubflowIgnored, workingNodesForFlow } from "../../shared/graph";
import { boundedKnowledgeNeighborhood } from "../../shared/knowledgeGraph";
import { compactImplementationScope, implementationScopeAdvisory, semanticRetrievalAdvisory } from "../../shared/implementationScope";
import { deriveContextBudgetPlan, estimateTextTokens } from "../../shared/contextBudget";
import { archicodeCapabilityDigest, archicodeCapabilityVersion, archicodeCurrentProjectOptions } from "../../shared/appCapabilities";
import { compactProjectConventions, readProjectConventions } from "../projectConventions";
import { getGitStatus } from "../projectTools";
import { enabledMcpServers } from "../mcp";
import { summarizeWithProvider } from "../providers";
import { searchSemanticIndex, semanticRelatedNodeIds, type SemanticSearchResult } from "../semanticIndex";
import { defaultLocalEnvironment, hydrateProviderForUse, loadProject } from "./projectStore";
import { sortNotesForModelContext, uniqueIds } from "./runEngine";
import { CONTEXT_GRAPH_CHANGE_LIMIT, shouldIncludeNoteInLlmContext } from "./ledgers";
import { noteAttachmentMetadata } from "./artifacts";
import { id, iso, projectStatePath, writeJson } from "./persistence";

export function normalizeRunScope(flow: Flow, nodeId?: string, scope?: RunScope): RunScope {
  const parsed = scope ? runScopeSchema.parse(scope) : runScopeSchema.parse({ kind: nodeId ? "nodes" : "flow", flowId: flow.id, nodeIds: nodeId ? [nodeId] : [] });
  const nodeIds = uniqueIds((parsed.kind === "nodes" ? parsed.nodeIds : nodeId ? [nodeId] : [])
    .filter((idValue) => flow.nodes.some((node) => node.id === idValue)));
  return {
    ...parsed,
    flowId: parsed.flowId ?? flow.id,
    nodeIds: parsed.kind === "nodes" ? nodeIds : [],
    label: parsed.label
  };
}

export function runScopeDirective(scope: RunScope, bundle: ProjectBundle, flow: Flow): string {
  if (scope.kind === "no-scope") {
    return "Treat this AI Implement run as a no-scope tactical edit. Use it only for trivial, localized source changes that do not alter architecture, flow responsibilities, node meaning, acceptance criteria, data contracts, notes, or graph truth. You may inspect project files and graph context for references, but do not produce graph/node/flow diffs or notes for this run. If the requested implementation would contradict or materially affect existing nodes or flows, stop and report that the graph must be updated or approved first instead of making the source change.";
  }
  if (scope.kind === "project") {
    return "Focus this AI Implement run on the whole project. The active flow is available as the context anchor, but source, graph diffs, node data, and notes may be updated wherever the project-level task requires it.";
  }
  if (scope.kind === "nodes") {
    const titles = scope.nodeIds
      .map((idValue) => flow.nodes.find((node) => node.id === idValue)?.title ?? idValue)
      .join(", ");
    return `Focus this AI Implement run on the selected node scope: ${titles || "no selected nodes"}. You may inspect other project flows or nodes for references, connected graph context, and consistency, but implementation edits, graph/node diffs, data, and notes should stay centered on these selected nodes unless a directly related supporting change is required.`;
  }
  const flowName = bundle.flows.find((item) => item.id === (scope.flowId ?? flow.id))?.name ?? flow.name;
  return `Focus this AI Implement run on flow "${flowName}". You may inspect other project flows or nodes for references, connected graph context, and consistency, but implementation edits, graph/node diffs, data, and notes should stay centered on this flow unless a directly related supporting change is required.`;
}

export async function currentGitContext(projectRoot: string): Promise<Record<string, unknown>> {
  try {
    const status = await getGitStatus(projectRoot);
    if (!status.isRepo) {
      return {
        isRepo: false,
        message: status.message || "No Git repository found.",
        guidance: "This project folder is not currently a Git repository. Do not repeatedly run git status or git rev-parse as a repo probe unless the user asks to initialize/use Git."
      };
    }
    return {
      isRepo: true,
      repoRoot: status.repoRoot,
      currentBranch: status.currentBranch,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      branchCount: status.branches.length,
      changedFileCount: status.changes.length,
      recentCommitCount: status.recentCommits.length,
      guidance: "This Git summary was refreshed for this agent call. Use it before probing basic repository state again."
    };
  } catch (error) {
    return {
      isRepo: false,
      message: error instanceof Error ? error.message : String(error),
      guidance: "Git status could not be read by ArchiCode for this agent call. Avoid repeated Git probes unless Git state is directly relevant."
    };
  }
}

// Compact acceptance-check rollup for summarized nodes, so agents see check
// coverage/pass state on every node without the full check objects. Undefined
// when a node has no checks, to keep the summary lean.
export function summarizeAcceptanceChecks(node: Flow["nodes"][number]): { total: number; passing: number; failing: number; unverified: number } | undefined {
  if (!node.acceptanceChecks.length) return undefined;
  return {
    total: node.acceptanceChecks.length,
    passing: node.acceptanceChecks.filter((check) => check.status === "passing").length,
    failing: node.acceptanceChecks.filter((check) => check.status === "failing").length,
    unverified: node.acceptanceChecks.filter((check) => check.status === "unverified").length
  };
}

export function projectGraphForRunContext(bundle: ProjectBundle): Array<{
  id: string;
  name: string;
  description: string;
  groups: Flow["groups"];
  subflows: Flow["subflows"];
  edges: Flow["edges"];
  nodes: Array<Record<string, unknown>>;
}> {
  return bundle.flows.filter((flow) => !flow.ignored).map((flow) => {
    const nodes = workingNodesForFlow(flow);
    const nodeIds = new Set(nodes.map((node) => node.id));
    return {
      id: flow.id,
      name: flow.name,
      description: flow.description,
      groups: flow.groups,
      subflows: flow.subflows.filter((subflow) => !isSubflowIgnored(flow, subflow.id)),
      edges: visibleEdgesForWorkingNodes(flow, nodeIds).map(({ evidence: _evidence, ...edge }) => edge),
      nodes: nodes.map((node) => ({
        id: node.id,
        type: node.type,
        title: node.title,
        description: node.description,
        stage: node.stage,
        flags: node.flags,
        locked: node.locked,
        subflowId: node.subflowId,
        groupId: node.groupId,
        techStack: node.techStack,
        acceptanceCriteria: node.acceptanceCriteria,
        acceptanceCheckSummary: summarizeAcceptanceChecks(node),
        implementationScope: compactImplementationScope(node.implementationScope),
        customProperties: node.customProperties,
        ruleIds: node.ruleIds ?? []
      }))
    };
  });
}

export async function buildContext(
  projectRoot: string,
  flowId: string,
  nodeId?: string,
  providerId?: string,
  scope?: RunScope,
  options: { persistArtifacts?: boolean } = {}
): Promise<{ text: string; artifacts: Artifact[]; summary: RunContextSummary }> {
  const persistArtifacts = options.persistArtifacts ?? true;
  const bundle = await loadProject(projectRoot);
  const flow = bundle.flows.find((item) => item.id === flowId) ?? bundle.flows[0];
  if (!flow) {
    return {
      text: JSON.stringify({ project: bundle.project, error: "No flow is available." }, null, 2),
      artifacts: [],
      summary: {
        items: [{ label: "project", count: 1, detail: "No flow was available." }],
        reasons: ["No flow was available, so only project metadata was included."]
      }
    };
  }
  if (flow.ignored) {
    throw new Error(`Flow "${flow.name}" is ignored and outside the agent working set. Restore it before running AI work.`);
  }
  const contextSettings = bundle.project.settings.contextBuilder;
  const budgetPlan = deriveContextBudgetPlan(bundle.project.settings);
  const runScope = normalizeRunScope(flow, nodeId, scope);
  const selectedNodeIds = runScope.kind === "nodes" ? runScope.nodeIds : runScope.kind === "no-scope" ? [] : nodeId ? [nodeId] : [];
  const selectedNode = nodeId
    ? flow.nodes.find((node) => node.id === nodeId)
    : selectedNodeIds[0]
      ? flow.nodes.find((node) => node.id === selectedNodeIds[0])
      : undefined;
  const ignoredSelectedNodes = selectedNodeIds
    .map((idValue) => flow.nodes.find((node) => node.id === idValue))
    .filter((node): node is Flow["nodes"][number] => Boolean(node?.ignored || isSubflowIgnored(flow, node?.subflowId)));
  if (selectedNode && (selectedNode.ignored || isSubflowIgnored(flow, selectedNode.subflowId))) {
    throw new Error(`Node "${selectedNode.title}" is ignored and outside the agent working set. Restore it before running AI work.`);
  }
  if (ignoredSelectedNodes.length) {
    throw new Error(`Node "${ignoredSelectedNodes[0].title}" is ignored and outside the agent working set. Restore it before running AI work.`);
  }
  const projectConventions = await readProjectConventions(projectRoot);
  const memoryRecords = await writeContextMemory(projectRoot, bundle, flow, { persist: persistArtifacts });
  let semanticRelatedIds: string[] = [];
  let semanticCodeMatches: SemanticSearchResult[] = [];
  if (bundle.project.settings.semanticIndex.enabled) {
    const queryNodes = selectedNodeIds.map((idValue) => flow.nodes.find((node) => node.id === idValue)).filter((node): node is Flow["nodes"][number] => Boolean(node));
    const semanticQuery = queryNodes.length
      ? queryNodes.map((node) => `${node.title}\n${node.description}\n${node.acceptanceCriteria.join("\n")}`).join("\n")
      : `${flow.name}\n${runScope.label ?? "active implementation work"}`;
    try {
      semanticRelatedIds = (await semanticRelatedNodeIds(projectRoot, bundle, semanticQuery, bundle.project.settings.semanticIndex.maxRelatedNodes))
        .filter((result) => result.flowId === flow.id && !selectedNodeIds.includes(result.nodeId))
        .map((result) => result.nodeId);
      semanticCodeMatches = await searchSemanticIndex(projectRoot, semanticQuery, {
        kinds: ["code-file"],
        limit: bundle.project.settings.semanticIndex.maxRelatedNodes,
        minScore: 0.38
      });
    } catch {
      semanticRelatedIds = [];
      semanticCodeMatches = [];
    }
  }
  const plan = planContextWorkingSet(bundle, flow, selectedNodeIds, semanticRelatedIds);
  const includedNodeSet = new Set(plan.includedNodeIds);
  const summarizedNodeSet = new Set(plan.summarizedNodeIds);
  const workingNodes = workingNodesForFlow(flow);
  const workingNodeIds = new Set(workingNodes.map((node) => node.id));
  const ignoredGraph = compactIgnoredGraph(bundle);
  const detailedNodes = flow.nodes.filter((node) =>
    !node.ignored &&
    !isSubflowIgnored(flow, node.subflowId) &&
    includedNodeSet.has(node.id) &&
    (contextSettings.includeLockedNodes || !node.locked || selectedNodeIds.includes(node.id))
  );
  const projectNodeRules = (bundle.project.settings.nodeRules ?? []).filter((rule) => (rule.status ?? "active") === "active");
  const ruleById = new Map(projectNodeRules.map((rule) => [rule.id, rule]));
  const resolveNodeRules = (node: Flow["nodes"][number]): Array<{ id: string; title: string; body: string }> =>
    (node.ruleIds ?? []).flatMap((ruleId) => {
      const rule = ruleById.get(ruleId);
      return rule ? [{ id: rule.id, title: rule.title, body: rule.body }] : [];
    });
  const detailedNodesWithRules = detailedNodes.map((node) => ({
    ...node,
    attachedRules: resolveNodeRules(node)
  }));
  const includedNodeIds = new Set(detailedNodes.map((node) => node.id));
  const summarizedNodes = workingNodes
    .filter((node) => summarizedNodeSet.has(node.id) || !includedNodeIds.has(node.id))
    .map((node) => ({
      id: node.id,
      type: node.type,
      title: node.title,
      description: node.description,
      stage: node.stage,
      flags: node.flags,
      locked: node.locked,
      subflowId: node.subflowId,
      groupId: node.groupId,
      ruleIds: node.ruleIds ?? [],
      attachedRules: resolveNodeRules(node),
      implementationScope: compactImplementationScope(node.implementationScope),
      acceptanceCheckSummary: summarizeAcceptanceChecks(node)
    }));
  const nodeNotes = contextSettings.includeNotes
    ? sortNotesForModelContext(bundle.notes.filter((note) =>
      note.flowId === flow.id &&
      shouldIncludeNoteInLlmContext(note) &&
      workingNodeIds.has(note.nodeId) &&
      (includedNodeIds.has(note.nodeId) || (note.kind === "llm-question" && !note.resolved))
    ))
    : [];
  const nodeNotesWithAttachments = nodeNotes.map((note) => ({
    ...note,
    attachments: noteAttachmentMetadata(bundle, note)
  }));
  const relatedRuns = contextSettings.includeRuns
    ? bundle.runs.filter((run) => run.flowId === flow.id && (!run.nodeId || includedNodeIds.has(run.nodeId) || run.status === "failed"))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, budgetPlan.recentRunLimit)
    : [];
  const artifacts = contextSettings.includeArtifacts
    ? bundle.artifacts.filter((artifact) =>
      artifact.type !== "chat-artifact" && (
        (!artifact.nodeId || includedNodeIds.has(artifact.nodeId)) ||
        (artifact.runId && relatedRuns.some((run) => run.id === artifact.runId))
      )
    ).slice(-budgetPlan.artifactLimit)
    : [];
  const pendingGraphChanges = graphChangesForContext(bundle, flow, includedNodeIds, workingNodeIds, selectedNodeIds);
  const graphChangeHistory = {
    includedPendingLimit: CONTEXT_GRAPH_CHANGE_LIMIT,
    fullLedgerPath: ".archicode/graph-changes.jsonl",
    archiveLedgerPath: ".archicode/graph-changes-archive.jsonl",
    note: "pendingGraphChanges is a compact recent/relevant window. If more or all historical graph change detail is needed, inspect the JSONL ledger in fullLedgerPath; resolved records older than the project's retention window are compacted into archiveLedgerPath."
  };
  const summaries = contextSettings.includeSummaries
    ? bundle.summaries.slice(-budgetPlan.artifactLimit)
    : [];
  const gitContext = await currentGitContext(projectRoot);
  const selectedMemory = memoryRecords.filter((record) =>
    record.scope === "project" ||
    record.scopeId === flow.id ||
    (record.nodeId && (includedNodeIds.has(record.nodeId) || selectedNodeIds.includes(record.nodeId)))
  );
  const manifest = await writeContextManifest(projectRoot, {
    flow,
    nodeId,
    budgetPlan,
    estimatedSize: 0,
    selectedNodeIds,
    includedNodeIds: [...includedNodeIds],
    summarizedNodeIds: summarizedNodes.map((node) => node.id),
    includedNoteIds: nodeNotes.map((note) => note.id),
    includedArtifactIds: artifacts.map((artifact) => artifact.id),
    includedRunIds: relatedRuns.map((run) => run.id),
    includedSummaryIds: summaries.map((summary) => summary.id),
    memoryRecordIds: selectedMemory.map((record) => record.id),
    reasons: plan.reasons
  }, { persist: persistArtifacts });
  const manifestArtifact: Artifact = {
    id: manifest.id,
    type: "context-manifest",
    title: `Context manifest for ${selectedNode?.title ?? flow.name}`,
    path: `.archicode/manifests/${manifest.id}.json`,
    nodeId,
    summary: `${includedNodeIds.size} detailed nodes, ${summarizedNodes.length} summarized nodes, ${nodeNotes.length} notes.`,
    sizeBytes: Buffer.byteLength(JSON.stringify(manifest), "utf8"),
    createdAt: manifest.createdAt
  };
  if (persistArtifacts) {
    await writeJson(projectStatePath(projectRoot, "artifacts", `${manifestArtifact.id}.json`), artifactSchema.parse(manifestArtifact));
  }
  const contextSummary: RunContextSummary = {
    items: [
      { label: "selected nodes", count: selectedNodeIds.length, detail: selectedNodeIds.length === 1 ? selectedNode?.title : `${selectedNodeIds.length} nodes` },
      { label: "detailed nodes", count: includedNodeIds.size },
      { label: "summarized nodes", count: summarizedNodes.length },
      { label: "ignored graph items", count: ignoredGraph.flows.length + ignoredGraph.nodes.length },
      { label: "notes", count: nodeNotes.length },
      { label: "pending graph changes", count: pendingGraphChanges.length },
      { label: "recent runs", count: relatedRuns.length },
      { label: "artifacts", count: artifacts.length },
      { label: "summaries", count: summaries.length },
      { label: "semantic code matches", count: semanticCodeMatches.length, detail: semanticCodeMatches.length ? "Local meaning-based retrieval" : "No semantic code matches" }
    ],
    reasons: Object.entries(plan.reasons)
      .flatMap(([idValue, reasons]) => {
        const node = flow.nodes.find((item) => item.id === idValue);
        const uniqueReasons = [...new Set(reasons)];
        return uniqueReasons.map((reason) => `${node?.title ?? idValue}: ${reason}`);
      })
      .filter((value, index, values) => values.indexOf(value) === index)
      .slice(0, 12)
  };

  const fullContextLifecycle = {
    tier: "full" as const,
    note: "Full planned run context fit within the active model budget."
  };
  const knowledgeEvidenceEdgeIds = new Set(boundedKnowledgeNeighborhood(
    flow,
    selectedNodeIds.length ? selectedNodeIds : [...includedNodeIds],
    { depth: 2, maxNodes: 24, maxEdges: 24, direction: "both" }
  ).edgeIds);
  const projectScopeGraph = runScope.kind === "project" ? projectGraphForRunContext(bundle) : undefined;
  const attributionFlows = runScope.kind === "project"
    ? bundle.flows.filter((candidate) => !candidate.ignored)
    : [flow];
  const sourceAttributionAllowedNodes = attributionFlows.flatMap((candidateFlow) =>
    workingNodesForFlow(candidateFlow).map((candidateNode) => ({
      flowId: candidateFlow.id,
      nodeId: candidateNode.id,
      title: candidateNode.title,
      type: candidateNode.type,
      description: candidateNode.description.slice(0, 240),
      implementationScope: compactImplementationScope(candidateNode.implementationScope, 4)
    }))
  );
  const context = {
    contextLifecycle: fullContextLifecycle,
    archicodeApp: {
      capabilityVersion: archicodeCapabilityVersion,
      capabilities: archicodeCapabilityDigest(),
      currentProjectOptions: archicodeCurrentProjectOptions(bundle.project.settings),
      role: "ArchiCode is the local graph, context, implementation, build, runtime, and debug harness coordinating this run."
    },
    project: {
      id: bundle.project.id,
      name: bundle.project.name,
      description: bundle.project.description,
      rootPath: bundle.project.rootPath,
      git: gitContext,
      settings: {
        localEnvironment: bundle.project.settings.localEnvironment ?? defaultLocalEnvironment(projectRoot),
        environmentNotes: bundle.project.settings.environmentNotes,
        stackAssumptions: bundle.project.settings.stackAssumptions,
        customNodeProperties: bundle.project.settings.customNodeProperties,
        nodeRules: projectNodeRules,
        defaultBuildCommand: bundle.project.settings.defaultBuildCommand,
        defaultRunCommand: bundle.project.settings.defaultRunCommand,
        buildTargetsLocked: bundle.project.settings.buildTargetsLocked,
        buildTargetPolicy: bundle.project.settings.buildTargetsLocked
          ? "LOCKED: use the configured build command and run targets exactly as provided. Do not infer, create, replace, reconcile, or propose build/run target changes. If a configured target fails, report that failure without rewriting target configuration."
          : "Unlocked: build and run targets may be inferred or corrected when evidence requires it.",
        runTargetProfiles: bundle.project.settings.runTargetProfiles,
        filesystem: bundle.project.settings.filesystem,
        webSearch: bundle.project.settings.webSearch,
        skills: bundle.project.settings.skills,
        mcp: {
          enabledServers: enabledMcpServers(bundle.project.settings).map((server) => ({
            id: server.id,
            label: server.label,
            trusted: server.trusted,
            tools: server.tools.map((tool) => ({ name: tool.name, description: tool.description }))
          }))
        }
      }
    },
    projectConventions,
    contextBudget: budgetPlan,
    contextManifest: manifest,
    ignoredGraph,
    graphIndex: {
      flow: {
        id: flow.id,
        name: flow.name,
        description: flow.description,
        groups: flow.groups,
        subflows: flow.subflows.filter((subflow) => !isSubflowIgnored(flow, subflow.id)),
        edges: visibleEdgesForWorkingNodes(flow, workingNodeIds).map(({ evidence: _evidence, ...edge }) => edge),
        evidenceSlice: visibleEdgesForWorkingNodes(flow, workingNodeIds)
          .filter((edge) => edge.evidence && knowledgeEvidenceEdgeIds.has(edge.id))
          .slice(0, 24)
          .map((edge) => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            label: edge.label,
            evidence: edge.evidence ? {
              ...edge.evidence,
              locations: edge.evidence.locations.slice(0, 3)
            } : undefined
          }))
      },
      flows: bundle.flows.filter((item) => !item.ignored).map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        nodeCount: workingNodesForFlow(item).length
      })),
      projectGraph: projectScopeGraph,
      detailedNodeIds: [...includedNodeIds],
      summarizedNodeIds: summarizedNodes.map((node) => node.id)
    },
    runScope: {
      ...runScope,
      directive: runScopeDirective(runScope, bundle, flow)
    },
    sourceAttribution: {
      required: true,
      contract: "Every proposed source-file change must include nodeIds with one or more IDs from allowedNodes. Attribution improves advisory Implementation Scope and run history; it is not exclusive ownership and is never used for drift alarms.",
      selectionGuidance: "Use the node or nodes whose stated intent the file directly implements or supports. Existing implementationScope and semanticRetrieval.codeMatches are bounded discovery hints; inspect the working file before relying on either.",
      allowedNodes: sourceAttributionAllowedNodes
    },
    implementationScopePolicy: implementationScopeAdvisory,
    semanticRetrieval: {
      ...semanticRetrievalAdvisory,
      codeMatches: semanticCodeMatches.map((match) => ({ path: match.ref, score: Number(match.score.toFixed(3)), symbol: match.metadata?.symbol, startLine: match.metadata?.startLine ? Number(match.metadata.startLine) : undefined, endLine: match.metadata?.endLine ? Number(match.metadata.endLine) : undefined, preview: match.preview }))
    },
    memory: selectedMemory,
    selectedNode: selectedNode ? { ...selectedNode, attachedRules: resolveNodeRules(selectedNode) } : selectedNode,
    detailedNodes: detailedNodesWithRules,
    summarizedNodes,
    graphChangeHistory,
    pendingGraphChanges,
    attachmentPolicy: {
      default: "Node/note attachments are listed as metadata on notes and in artifacts. Do not assume attachment contents are already loaded.",
      agentGuidance: "Use archicode_project_read_artifact with an attachment id or path only when the task needs the attachment contents or visual details."
    },
    notes: nodeNotesWithAttachments,
    recentRuns: relatedRuns,
    artifacts,
    summaries
  };

  const contextText = JSON.stringify(context, null, 2);
  const contextTokens = estimateTextTokens(contextText);
  const contextSummaryWithBudget: RunContextSummary = {
    ...contextSummary,
    budget: {
      estimatedTokens: contextTokens,
      maxTokens: budgetPlan.modelContextTokens,
      compactionThreshold: budgetPlan.compactionThreshold,
      source: budgetPlan.source
    },
    contextLifecycle: fullContextLifecycle
  };
  manifest.budget.estimatedSize = estimateContextSize(context);
  manifest.contextLifecycle = fullContextLifecycle;
  if (persistArtifacts) {
    await writeJson(projectStatePath(projectRoot, "manifests", `${manifest.id}.json`), contextManifestSchema.parse(manifest));
  }
  if (contextTokens <= budgetPlan.compactionThreshold) {
    return { text: contextText, artifacts: persistArtifacts ? [manifestArtifact] : [], summary: contextSummaryWithBudget };
  }

  const provider = providerId ? bundle.project.settings.providers.find((item) => item.id === providerId) : undefined;
  const summaryText = await summarizeWithProvider(provider ? await hydrateProviderForUse(provider) : provider, contextText, projectRoot);
  const summaryArtifact: Artifact = {
    id: id("summary"),
    type: "summary",
    title: `Compacted context for ${selectedNode?.title ?? flow?.name ?? "project"}`,
    path: `.archicode/summaries/context-${Date.now()}.json`,
    nodeId,
    createdAt: iso()
  };

  if (persistArtifacts) {
    await writeJson(path.join(projectRoot, summaryArtifact.path), {
      ...summaryArtifact,
      summary: summaryText,
      originalSize: estimateContextSize(context),
      originalTokens: contextTokens,
      summaryProviderId: provider?.id ?? "local-fallback"
    });
  }

  const compactLifecycle: ContextLifecycle = {
    tier: "compact" as const,
    note: "Run context was deliberately compacted to stay within the active model budget. Use the manifest, memory, graph-change ledger, artifacts, and project files to rebuild omitted detail when needed."
  };
  const compactedProjectConventions = compactProjectConventions(projectConventions);
  const compactedGraphIndex = {
    flow: context.graphIndex.flow,
    flows: context.graphIndex.flows,
    projectGraph: context.graphIndex.projectGraph,
    detailedNodeIds: context.graphIndex.detailedNodeIds,
    summarizedNodeIds: context.graphIndex.summarizedNodeIds
  };
  const compactedContext = {
    contextLifecycle: compactLifecycle,
    archicodeApp: context.archicodeApp,
    project: context.project,
    projectConventions: compactedProjectConventions,
    contextBudget: budgetPlan,
    contextManifest: manifest,
    ignoredGraph,
    graphIndex: compactedGraphIndex,
    runScope: context.runScope,
    implementationScopePolicy: implementationScopeAdvisory,
    semanticRetrieval: context.semanticRetrieval,
    graphChangeHistory,
    pendingGraphChanges,
    memory: selectedMemory,
    rebuildInstructions: [
      "The contextManifest records which graph nodes, notes, runs, summaries, memory records, and artifacts were part of the full context before compaction.",
      "Treat compactedSummary and memory as continuity anchors, not exhaustive graph truth.",
      "For local coding providers, inspect project files and .archicode artifacts/ledgers when exact source, graph, run, or artifact detail is needed.",
      "For API providers, rely on the compacted summary plus artifact ids and ask for replanning if omitted detail is required to continue safely."
    ],
    compactedSummary: summaryText
  };
  let compactedText = JSON.stringify(compactedContext, null, 2);
  let compactedTokens = estimateTextTokens(compactedText);
  let lifecycle: ContextLifecycle = compactLifecycle;

  if (compactedTokens > budgetPlan.compactionThreshold) {
    lifecycle = {
      tier: "minimal-resumable" as const,
      note: "Run context entered the minimal-resumable lifecycle because the compacted context was still above budget. Continuity anchors and reload paths are preserved so the agent can rebuild detail instead of crashing."
    };
    compactedText = JSON.stringify({
      contextLifecycle: lifecycle,
      archicodeApp: context.archicodeApp,
      project: {
        id: bundle.project.id,
        name: bundle.project.name,
        description: bundle.project.description,
        rootPath: bundle.project.rootPath,
        git: gitContext
      },
      runScope: {
        ...runScope,
        directive: runScopeDirective(runScope, bundle, flow)
      },
      projectConventions: compactedProjectConventions,
      graphIndex: compactedGraphIndex,
      implementationScopePolicy: implementationScopeAdvisory,
      contextBudget: budgetPlan,
      contextManifest: {
        id: manifest.id,
        path: `.archicode/manifests/${manifest.id}.json`,
        selectedNodeIds: manifest.selectedNodeIds,
        includedNodeIds: manifest.includedNodeIds,
        summarizedNodeIds: manifest.summarizedNodeIds,
        includedNoteIds: manifest.includedNoteIds,
        includedArtifactIds: manifest.includedArtifactIds,
        includedRunIds: manifest.includedRunIds,
        includedSummaryIds: manifest.includedSummaryIds,
        memoryRecordIds: manifest.memoryRecordIds
      },
      graphChangeHistory,
      memory: selectedMemory.map((record) => ({
        id: record.id,
        scope: record.scope,
        scopeId: record.scopeId,
        flowId: record.flowId,
        nodeId: record.nodeId,
        title: record.title,
        summary: record.summary,
        facts: record.facts.slice(0, 6),
        decisions: record.decisions.slice(-4),
        openQuestions: record.openQuestions.slice(-4),
        artifactIds: record.artifactIds.slice(-8),
        runIds: record.runIds.slice(-6),
        updatedAt: record.updatedAt
      })),
      rebuildInstructions: [
        "This is a planned minimal-resumable run context, not a failure state.",
        "Use the manifest path and listed ids to recover omitted graph, note, run, artifact, and memory detail when available.",
        "For local coding providers, inspect project files and .archicode records directly before making source changes that depend on omitted detail.",
        "If exact omitted detail is required but unavailable to this provider, stop safely and request replanning rather than guessing."
      ],
      compactedSummary: summaryText.slice(0, Math.max(1200, budgetPlan.summaryReserveTokens * 4))
    }, null, 2);
    compactedTokens = estimateTextTokens(compactedText);
  }
  manifest.contextLifecycle = lifecycle;
  if (persistArtifacts) {
    await writeJson(projectStatePath(projectRoot, "manifests", `${manifest.id}.json`), contextManifestSchema.parse(manifest));
  }
  return {
    text: compactedText,
    artifacts: persistArtifacts ? [manifestArtifact, summaryArtifact] : [],
    summary: {
      ...contextSummaryWithBudget,
      budget: {
        estimatedTokens: compactedTokens,
        maxTokens: budgetPlan.modelContextTokens,
        compactionThreshold: budgetPlan.compactionThreshold,
        source: budgetPlan.source
      },
      contextLifecycle: lifecycle,
      reasons: [...contextSummary.reasons, lifecycle.tier === "minimal-resumable"
        ? "Context entered the minimal-resumable lifecycle because compacted context still exceeded the configured threshold."
        : "Context was compacted because it exceeded the configured threshold."]
    }
  };
}

export type ContextPlan = {
  includedNodeIds: string[];
  summarizedNodeIds: string[];
  reasons: Record<string, string[]>;
};

export function compactIgnoredGraph(bundle: ProjectBundle): {
  flows: Array<{ id: string; name: string; description: string }>;
  subflows: Array<{ id: string; flowId: string; name: string; parentSubflowId?: string; parentNodeId?: string }>;
  nodes: Array<{ id: string; flowId: string; title: string; type: string; stage: Flow["nodes"][number]["stage"]; description: string; flowIgnored: boolean; subflowIgnored: boolean }>;
} {
  return {
    flows: bundle.flows
      .filter((flow) => flow.ignored)
      .map((flow) => ({ id: flow.id, name: flow.name, description: flow.description })),
    subflows: bundle.flows.flatMap((flow) =>
      flow.subflows
        .filter((subflow) => !flow.ignored && isSubflowIgnored(flow, subflow.id))
        .map((subflow) => ({
          id: subflow.id,
          flowId: flow.id,
          name: subflow.name,
          parentSubflowId: subflow.parentSubflowId,
          parentNodeId: subflow.parentNodeId
        }))
    ),
    nodes: bundle.flows.flatMap((flow) =>
      flow.nodes
        .filter((node) => flow.ignored || node.ignored || isSubflowIgnored(flow, node.subflowId))
        .map((node) => ({
          id: node.id,
          flowId: flow.id,
          title: node.title,
          type: node.type,
          stage: node.stage,
          description: node.description,
          flowIgnored: flow.ignored,
          subflowIgnored: isSubflowIgnored(flow, node.subflowId)
        }))
    )
  };
}

export function visibleEdgesForWorkingNodes(flow: Flow, workingNodeIds: Set<string>): Flow["edges"] {
  return flow.edges.filter((edge) => workingNodeIds.has(edge.source) && workingNodeIds.has(edge.target));
}

export function graphChangesForContext(
  bundle: ProjectBundle,
  flow: Flow,
  includedNodeIds: Set<string>,
  workingNodeIds: Set<string>,
  selectedNodeIds: string[] = []
): Array<Pick<GraphChangeRecord, "id" | "actor" | "kind" | "summary" | "nodeIds" | "edgeIds" | "subflowIds" | "fieldPaths" | "snippets" | "createdAt">> {
  const selectedNodeIdSet = new Set(selectedNodeIds);
  return bundle.graphChanges
    .filter((change) => {
      if (change.flowId !== flow.id || change.status !== "pending") return false;
      if (selectedNodeIdSet.size) return change.nodeIds.some((idValue) => selectedNodeIdSet.has(idValue) || includedNodeIds.has(idValue));
      return !change.nodeIds.length || change.nodeIds.some((nodeId) => workingNodeIds.has(nodeId));
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, CONTEXT_GRAPH_CHANGE_LIMIT)
    .map((change) => ({
      id: change.id,
      actor: change.actor,
      kind: change.kind,
      summary: change.summary,
      nodeIds: change.nodeIds,
      edgeIds: change.edgeIds,
      subflowIds: change.subflowIds,
      fieldPaths: change.fieldPaths,
      snippets: change.snippets,
      createdAt: change.createdAt
    }));
}

export function planContextWorkingSet(bundle: ProjectBundle, flow: Flow, selectedNodeIds: string[] = [], semanticRelatedNodeIds: string[] = []): ContextPlan {
  const reasons: Record<string, string[]> = {};
  const included = new Set<string>();
  const add = (idValue: string | undefined, reason: string) => {
    if (!idValue || !flow.nodes.some((node) => node.id === idValue && !node.ignored && !isSubflowIgnored(flow, node.subflowId))) return;
    included.add(idValue);
    reasons[idValue] = [...(reasons[idValue] ?? []), reason];
  };
  const workingNodes = workingNodesForFlow(flow);
  const workingNodeIds = new Set(workingNodes.map((node) => node.id));
  const childSubflowIds = (parentSubflowId: string): string[] => {
    const directChildren = flow.subflows.filter((subflow) => subflow.parentSubflowId === parentSubflowId).map((subflow) => subflow.id);
    return directChildren.flatMap((subflowId) => [subflowId, ...childSubflowIds(subflowId)]);
  };
  const linkedDetailSubflowIds = (nodeId: string): string[] => {
    const direct = flow.subflows.filter((subflow) => subflow.parentNodeId === nodeId).map((subflow) => subflow.id);
    return direct.flatMap((subflowId) => [subflowId, ...childSubflowIds(subflowId)]);
  };

  const openQuestionNodeIds = new Set(bundle.notes
    .filter((note) => note.flowId === flow.id && workingNodeIds.has(note.nodeId) && note.kind === "llm-question" && !note.resolved)
    .map((note) => note.nodeId));
  const failedRunNodeIds = new Set(bundle.runs
    .filter((run) => run.flowId === flow.id && run.nodeId && workingNodeIds.has(run.nodeId) && run.status === "failed")
    .map((run) => run.nodeId as string));
  const pendingGraphChangeNodeIds = new Set(bundle.graphChanges
    .filter((change) => change.flowId === flow.id && change.status === "pending")
    .flatMap((change) => change.nodeIds)
    .filter((idValue) => workingNodeIds.has(idValue)));

  if (selectedNodeIds.length) {
    for (const selectedNodeId of selectedNodeIds) {
      add(selectedNodeId, "selected node");
      for (const subflowId of linkedDetailSubflowIds(selectedNodeId)) {
        for (const detailNode of flow.nodes.filter((node) => node.subflowId === subflowId)) {
          add(detailNode.id, "selected node linked detail flow");
        }
      }
      for (const edge of flow.edges) {
        if (edge.source === selectedNodeId) add(edge.target, "selected node outgoing neighbor");
        if (edge.target === selectedNodeId) add(edge.source, "selected node incoming neighbor");
      }
    }
  } else {
    for (const node of workingNodes) {
      if (
        node.stage === "draft-rejected" ||
        node.flags.some((flag) => ["changed", "needs-attention", "llm-question", "modified-not-built"].includes(flag))
      ) {
        add(node.id, "active graph state");
      }
    }
  }

  for (const idValue of openQuestionNodeIds) add(idValue, "open agent question");
  for (const idValue of failedRunNodeIds) add(idValue, "failed recent run");
  for (const idValue of pendingGraphChangeNodeIds) add(idValue, "pending graph change");
  for (const idValue of semanticRelatedNodeIds) add(idValue, "semantic match to the active scope");

  for (const node of workingNodes) {
    if (!included.has(node.id)) continue;
    for (const edge of flow.edges) {
      if (edge.source === node.id) add(edge.target, "graph neighbor");
      if (edge.target === node.id) add(edge.source, "graph neighbor");
    }
  }

  const includedNodeIds = [...included].slice(0, 24);
  const summarizedNodeIds = workingNodes.map((node) => node.id).filter((idValue) => !includedNodeIds.includes(idValue));
  return { includedNodeIds, summarizedNodeIds, reasons };
}

export async function writeContextMemory(
  projectRoot: string,
  bundle: ProjectBundle,
  flow: Flow,
  options: { persist?: boolean } = {}
): Promise<ContextMemoryRecord[]> {
  const persist = options.persist ?? true;
  if (persist) await mkdir(projectStatePath(projectRoot, "memory"), { recursive: true });
  const records: ContextMemoryRecord[] = [];
  const activeFlowIds = new Set(bundle.flows.filter((item) => !item.ignored).map((item) => item.id));
  const activeNodeIds = new Set(bundle.flows.flatMap((item) =>
    item.ignored ? [] : workingNodesForFlow(item).map((node) => node.id)
  ));
  const activeNotes = bundle.notes.filter((note) =>
    isNoteActiveForModelContext(note) &&
    activeFlowIds.has(note.flowId) &&
    activeNodeIds.has(note.nodeId)
  );
  const notesByNode = new Map<string, Note[]>();
  for (const note of activeNotes.filter((item) => item.flowId === flow.id)) {
    notesByNode.set(note.nodeId, [...(notesByNode.get(note.nodeId) ?? []), note]);
  }

  const projectRecord = contextMemoryRecordSchema.parse({
    id: `memory-project-${bundle.project.id}`,
    scope: "project",
    scopeId: bundle.project.id,
    title: bundle.project.name,
    summary: bundle.project.description,
    facts: [
      `Stack: ${bundle.project.settings.stackAssumptions.join(", ") || "unknown"}`,
      `Build command: ${bundle.project.settings.defaultBuildCommand || "not configured"}`,
      `Run command: ${bundle.project.settings.defaultRunCommand || "not configured"}`,
      `Run targets: ${bundle.project.settings.runTargetProfiles.map((profile) => profile.label).join(", ") || "not configured"}`
    ],
    decisions: activeNotes.filter((note) => note.author === "user").slice(-8).map((note) => note.body),
    openQuestions: activeNotes.filter((note) => note.kind === "llm-question").map((note) => note.body),
    artifactIds: bundle.artifacts.filter((artifact) => artifact.type !== "chat-artifact").slice(-10).map((artifact) => artifact.id),
    runIds: bundle.runs.slice(-8).map((run) => run.id),
    updatedAt: iso()
  });
  records.push(projectRecord);

  const flowRecord = contextMemoryRecordSchema.parse({
    id: `memory-flow-${flow.id}`,
    scope: "flow",
    scopeId: flow.id,
    flowId: flow.id,
    title: flow.name,
    summary: flow.description,
    facts: [
      `${flow.nodes.length} nodes`,
      `${flow.edges.length} edges`,
      `${flow.subflows.length} subflows`
    ],
    decisions: [],
    openQuestions: activeNotes.filter((note) => note.flowId === flow.id && note.kind === "llm-question").map((note) => note.body),
    artifactIds: bundle.artifacts.filter((artifact) => artifact.type !== "chat-artifact" && !artifact.nodeId).slice(-8).map((artifact) => artifact.id),
    runIds: bundle.runs.filter((run) => run.flowId === flow.id).slice(-8).map((run) => run.id),
    updatedAt: iso()
  });
  records.push(flowRecord);

  const customPropertyLabels = new Map(bundle.project.settings.customNodeProperties.map((property) => [property.id, property.label]));
  const nodeRuleLabels = new Map((bundle.project.settings.nodeRules ?? []).map((rule) => [rule.id, rule.title]));
  for (const node of flow.nodes.filter((item) => !item.ignored)) {
    const notes = notesByNode.get(node.id) ?? [];
    const customProperties = Object.entries(node.customProperties ?? {})
      .map(([key, value]) => `${customPropertyLabels.get(key) ?? key}: ${value}`)
      .join("; ");
    records.push(contextMemoryRecordSchema.parse({
      id: `memory-node-${node.id}`,
      scope: "node",
      scopeId: node.id,
      flowId: flow.id,
      nodeId: node.id,
      title: node.title,
      summary: node.description,
      facts: [
        `Type: ${node.type}`,
        `Stage: ${node.stage}`,
        `Flags: ${node.flags.join(", ") || "none"}`,
        `Tech: ${node.techStack.join(", ") || "not specified"}`,
        `Acceptance: ${node.acceptanceCriteria.join("; ") || "not specified"}`,
        `Custom properties: ${customProperties || "none"}`,
        `Rules: ${(node.ruleIds ?? []).map((ruleId) => nodeRuleLabels.get(ruleId) ?? ruleId).join(", ") || "none"}`
      ],
      decisions: notes.filter((note) => note.author === "user").slice(-5).map((note) => note.body),
      openQuestions: notes.filter((note) => note.kind === "llm-question").map((note) => note.body),
      artifactIds: bundle.artifacts.filter((artifact) => artifact.type !== "chat-artifact" && artifact.nodeId === node.id).slice(-8).map((artifact) => artifact.id),
      runIds: bundle.runs.filter((run) => run.nodeId === node.id).slice(-5).map((run) => run.id),
      updatedAt: iso()
    }));
  }

  if (persist) {
    for (const record of records) {
      await writeJson(projectStatePath(projectRoot, "memory", `${record.id}.json`), record);
    }
  }
  return records;
}

export async function writeContextManifest(
  projectRoot: string,
  input: {
    flow: Flow;
    nodeId?: string;
    budgetPlan: ReturnType<typeof deriveContextBudgetPlan>;
    estimatedSize: number;
    selectedNodeIds: string[];
    includedNodeIds: string[];
    summarizedNodeIds: string[];
    includedNoteIds: string[];
    includedArtifactIds: string[];
    includedRunIds: string[];
    includedSummaryIds: string[];
    memoryRecordIds: string[];
    reasons: Record<string, string[]>;
  },
  options: { persist?: boolean } = {}
): Promise<ContextManifest> {
  const persist = options.persist ?? true;
  if (persist) await mkdir(projectStatePath(projectRoot, "manifests"), { recursive: true });
  const manifest = contextManifestSchema.parse({
    id: id("context"),
    flowId: input.flow.id,
    nodeId: input.nodeId,
    scope: input.nodeId ? "node" : "flow",
    budget: {
      source: input.budgetPlan.source,
      modelContextTokens: input.budgetPlan.modelContextTokens,
      compactionThreshold: input.budgetPlan.compactionThreshold,
      estimatedSize: input.estimatedSize
    },
    selectedNodeIds: input.selectedNodeIds,
    includedNodeIds: input.includedNodeIds,
    summarizedNodeIds: input.summarizedNodeIds,
    includedNoteIds: input.includedNoteIds,
    includedArtifactIds: input.includedArtifactIds,
    includedRunIds: input.includedRunIds,
    includedSummaryIds: input.includedSummaryIds,
    memoryRecordIds: input.memoryRecordIds,
    reasons: input.reasons,
    createdAt: iso()
  });
  if (persist) await writeJson(projectStatePath(projectRoot, "manifests", `${manifest.id}.json`), manifest);
  return manifest;
}

export type FilesystemScopeEvaluation = {
  allowed: boolean;
  policy: ProjectSettings["filesystem"]["policy"];
  cwd: string;
  allowedRoots: string[];
  violations: string[];
};

export type SourceSnapshot = Map<string, string>;

export async function evaluateFilesystemScope(
  projectRoot: string,
  settings: ProjectSettings,
  command: string,
  cwd: string,
  risk: "low" | "medium" | "high"
): Promise<FilesystemScopeEvaluation> {
  const policy = settings.filesystem.policy;
  const resolvedProjectRoot = await resolveExistingOrAbsolute(projectRoot);
  const resolvedCwd = await resolveExistingOrAbsolute(path.isAbsolute(cwd) ? cwd : path.resolve(projectRoot, cwd));
  const allowedRoots = await Promise.all(
    [projectRoot, ...settings.filesystem.allowedRoots].map((root) =>
      resolveExistingOrAbsolute(path.isAbsolute(root) ? root : path.resolve(projectRoot, root))
    )
  );
  const violations: string[] = [];

  if (policy === "full-access") {
    return { allowed: true, policy, cwd: resolvedCwd, allowedRoots, violations };
  }

  if (!isInsideAnyRoot(resolvedCwd, allowedRoots)) {
    violations.push(`Working directory is outside allowed roots: ${resolvedCwd}`);
  }

  if (policy === "read-only" && risk !== "low") {
    violations.push(`Read-only filesystem policy blocks ${risk}-risk shell command.`);
  }

  if (settings.filesystem.blockOutsideProjectPaths) {
    for (const token of extractCommandPathTokens(command)) {
      const target = resolveCommandTokenPath(token, resolvedCwd, resolvedProjectRoot);
      if (target && !isInsideAnyRoot(target, allowedRoots)) {
        violations.push(`Command references path outside allowed roots: ${token}`);
      }
    }
  }

  return {
    allowed: violations.length === 0,
    policy,
    cwd: resolvedCwd,
    allowedRoots,
    violations
  };
}

export async function resolveExistingOrAbsolute(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

export function isInsideAnyRoot(targetPath: string, roots: string[]): boolean {
  return roots.some((root) => isSameOrInside(root, targetPath));
}

export function isSameOrInside(rootPath: string, targetPath: string): boolean {
  const root = normalizeForCompare(rootPath);
  const target = normalizeForCompare(targetPath);
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeForCompare(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function extractCommandPathTokens(command: string): string[] {
  const matches = command.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
  return matches
    .map((token) => token.trim().replace(/^["']|["']$/g, "").replace(/[),;]+$/g, ""))
    .map((token) => token.startsWith("--") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token)
    .filter((token) => isCommandPathToken(token));
}

export function isCommandPathToken(token: string): boolean {
  if (!token || token.startsWith("-")) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) return false;
  return token.includes("/") ||
    token.includes("\\") ||
    token.startsWith(".") ||
    path.isAbsolute(token) ||
    path.win32.isAbsolute(token);
}

export function resolveCommandTokenPath(token: string, cwd: string, projectRoot: string): string | null {
  if (path.isAbsolute(token)) return path.resolve(token);
  if (path.win32.isAbsolute(token)) {
    return process.platform === "win32" ? path.resolve(token) : null;
  }
  if (token.startsWith("~")) return null;
  if (!token.includes("/") && !token.includes("\\") && !token.startsWith(".")) return null;
  return path.resolve(cwd || projectRoot, token);
}

export function scopeOpenQuestions(bundle: ProjectBundle, flowId: string, nodeId?: string): Note[] {
  const flow = bundle.flows.find((item) => item.id === flowId);
  const scopeNodeIds = new Set<string>();
  if (nodeId) {
    scopeNodeIds.add(nodeId);
    for (const edge of flow?.edges ?? []) {
      if (edge.source === nodeId) scopeNodeIds.add(edge.target);
      if (edge.target === nodeId) scopeNodeIds.add(edge.source);
    }
  }
  return bundle.notes.filter((note) =>
    note.flowId === flowId &&
    note.kind === "llm-question" &&
    !note.resolved &&
    (!nodeId || scopeNodeIds.has(note.nodeId))
  );
}
