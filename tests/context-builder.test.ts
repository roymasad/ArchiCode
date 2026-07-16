import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/main/storage/contextBuilder";
import { addNote, attachNodeReferences } from "../src/main/storage/notes";
import { createProject, ensureProject, loadProject, saveFlow, updateNode, updateProjectSettings } from "../src/main/storage/projectStore";

describe("context builder controls", () => {
  it("omits disabled context sections", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-"));
    const bundle = await ensureProject(root);
    await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-orchestrator",
      kind: "user-note",
      author: "user",
      body: "Private note outside context",
      resolved: false
    });
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      contextBuilder: {
        ...bundle.project.settings.contextBuilder,
        includeNotes: false,
        includeRuns: false,
        includeArtifacts: false,
        includeSummaries: false
      }
    });

    const context = await buildContext(root, "flow-main", "node-orchestrator", "offline-manual");
    const parsed = JSON.parse(context.text) as { notes: unknown[]; recentRuns: unknown[]; artifacts: unknown[]; summaries: unknown[]; semanticRetrieval: { authority: string; evidenceOrder: string; guidance: string; codeMatches: unknown[] } };

    expect(parsed.notes).toEqual([]);
    expect(parsed.recentRuns).toEqual([]);
    expect(parsed.artifacts).toEqual([]);
    expect(parsed.summaries).toEqual([]);
    expect(parsed.semanticRetrieval.authority).toBe("discovery-candidate");
    expect(parsed.semanticRetrieval.evidenceOrder).toContain("Implementation Scope is stronger structural orientation");
    expect(parsed.semanticRetrieval.guidance).toContain("never treat a match as permission");
  });

  it("adds fresh Git repository state to each agent context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-git-"));
    await ensureProject(root);

    const context = await buildContext(root, "flow-main", undefined, "offline-manual", undefined, { persistArtifacts: false });
    const parsed = JSON.parse(context.text) as {
      contextLifecycle: { tier: string };
      project: { git: { isRepo: boolean; guidance: string } };
      archicodeApp: { capabilityVersion: string; capabilities: { implementationAndRuntime: string[] }; currentProjectOptions: Record<string, unknown> };
    };

    expect(parsed.contextLifecycle.tier).toBe("full");
    expect(context.summary.contextLifecycle?.tier).toBe("full");
    expect(parsed.project.git.isRepo).toBe(false);
    expect(parsed.project.git.guidance).toContain("Do not repeatedly run git status");
    expect(parsed.archicodeApp.capabilityVersion).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(parsed.archicodeApp.capabilities.implementationAndRuntime.join(" ")).toContain("Agent Work Queue");
    expect(parsed.archicodeApp.currentProjectOptions).toHaveProperty("reviewAndApproval.planningReviewMode");
  });

  it("strips legacy hidden node dependencies from loaded and saved flows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-migrate-"));
    await ensureProject(root);
    const flowPath = path.join(root, ".archicode", "flows", "flow-main.json");
    const stored = JSON.parse(await readFile(flowPath, "utf8")) as {
      nodes: Record<string, Record<string, unknown>>;
    };
    const firstNodeId = Object.keys(stored.nodes)[0]!;
    stored.nodes[firstNodeId] = {
      ...stored.nodes[firstNodeId],
      dependencies: ["node-orchestrator"]
    };
    await writeFile(flowPath, JSON.stringify(stored, null, 2));

    const bundle = await loadProject(root);
    const reloaded = JSON.parse(await readFile(flowPath, "utf8")) as {
      nodes: Record<string, Record<string, unknown>>;
    };

    expect(Object.prototype.hasOwnProperty.call(bundle.flows[0]!.nodes[0] as object, "dependencies")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(reloaded.nodes[firstNodeId]!, "dependencies")).toBe(false);
  });

  it("creates a summary artifact when context exceeds threshold", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-compact-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      contextBudgetMode: "manual",
      compactionThreshold: 1
    });

    await writeFile(path.join(root, "AGENTS.md"), "# Compact Agent Rules\n\nPreserve run scope after compaction.\n", "utf8");
    const context = await buildContext(root, "flow-main", undefined, "offline-manual");
    expect(context.artifacts.some((artifact) => artifact.type === "context-manifest")).toBe(true);
    expect(context.artifacts.some((artifact) => artifact.type === "summary")).toBe(true);
    expect(context.summary.budget?.estimatedTokens).toBeGreaterThan(0);
    expect(context.summary.budget?.compactionThreshold).toBe(1);
    expect(context.text).toContain("compactedSummary");
    expect(context.summary.contextLifecycle?.tier).toBe("minimal-resumable");
    expect(context.text).toContain("\"tier\": \"minimal-resumable\"");
    expect(context.text).toContain("planned minimal-resumable run context");
    const compacted = JSON.parse(context.text) as {
      runScope?: { kind: string; directive: string };
      graphIndex?: { flow?: { id: string } };
      projectConventions?: { files?: Array<{ path: string; excerpt?: string }> };
      archicodeApp?: { capabilityVersion: string; capabilities: { implementationAndRuntime: string[] }; currentProjectOptions: Record<string, unknown> };
    };
    expect(compacted.runScope?.kind).toBe("flow");
    expect(compacted.runScope?.directive).toContain("Focus this AI Implement run on flow");
    expect(compacted.graphIndex?.flow?.id).toBe("flow-main");
    expect(compacted.projectConventions?.files?.find((file) => file.path === "AGENTS.md")?.excerpt).toContain("Preserve run scope after compaction");
    expect(compacted.archicodeApp?.capabilityVersion).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(compacted.archicodeApp?.capabilities.implementationAndRuntime.join(" ")).toContain("Agent Work Queue");
    expect(compacted.archicodeApp?.currentProjectOptions).toHaveProperty("context.budgetMode");
  });

  it("can build context without persisting artifacts or memory records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-preview-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      contextBudgetMode: "manual",
      compactionThreshold: 1
    });

    const context = await buildContext(root, "flow-main", undefined, "offline-manual", undefined, { persistArtifacts: false });
    const parsed = JSON.parse(context.text) as { contextLifecycle: { tier: string }; contextManifest: { id: string }; compactedSummary: string };

    expect(context.artifacts).toEqual([]);
    expect(parsed.contextLifecycle.tier).toBe("minimal-resumable");
    expect(parsed.compactedSummary).toContain("Context exceeded");
    await expect(readFile(path.join(root, ".archicode", "manifests", `${parsed.contextManifest.id}.json`), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(root, ".archicode", "memory", "memory-flow-flow-main.json"), "utf8")).rejects.toThrow();
  });

  it("builds a graph-aware context manifest and durable memory records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-plan-"));
    const bundle = await ensureProject(root);
    const flow = bundle.flows[0]!;
    await saveFlow(root, {
      ...flow,
      nodes: [
        ...flow.nodes,
        ...Array.from({ length: 4 }, (_, index) => ({
          ...flow.nodes[0]!,
          id: `node-unrelated-${index}`,
          title: `Unrelated ${index}`,
          summary: "A node outside the selected working neighborhood.",
          position: { x: 1000 + index * 120, y: 900 },
          flags: [],
          attachments: [],
          todos: []
        }))
      ]
    });
    const context = await buildContext(root, "flow-main", "node-orchestrator", "offline-manual");
    const parsed = JSON.parse(context.text) as {
      contextManifest: { includedNodeIds: string[]; summarizedNodeIds: string[]; reasons: Record<string, string[]> };
      memory: { id: string; scope: string }[];
      detailedNodes: { id: string }[];
      summarizedNodes: { id: string }[];
    };
    const manifestArtifact = context.artifacts.find((artifact) => artifact.type === "context-manifest");

    expect(parsed.contextManifest.includedNodeIds).toContain("node-orchestrator");
    expect(context.summary.budget?.estimatedTokens).toBeGreaterThan(0);
    expect(context.summary.budget?.maxTokens).toBeGreaterThan(0);
    expect(parsed.contextManifest.reasons["node-orchestrator"]).toContain("selected node");
    expect(parsed.memory.some((record) => record.scope === "project")).toBe(true);
    expect(parsed.detailedNodes.some((node) => node.id === "node-orchestrator")).toBe(true);
    expect(parsed.summarizedNodes.length).toBeGreaterThan(0);
    expect(manifestArtifact?.path).toContain(".archicode/manifests/");
    await expect(readFile(path.join(root, ".archicode", "memory", "memory-node-node-orchestrator.json"), "utf8")).resolves.toContain("Local Agent Orchestrator");
  });

  it("adds multi-node AI Implement scope directives to context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-scope-"));
    const bundle = await ensureProject(root);
    const flow = bundle.flows[0]!;
    const selectedNodeIds = flow.nodes.slice(0, 2).map((node) => node.id);

    const context = await buildContext(root, flow.id, selectedNodeIds[0], "offline-manual", {
      kind: "nodes",
      flowId: flow.id,
      nodeIds: selectedNodeIds,
      label: "Selected nodes"
    });
    const parsed = JSON.parse(context.text) as {
      contextManifest: { selectedNodeIds: string[]; includedNodeIds: string[] };
      detailedNodes: { id: string }[];
      runScope: { kind: string; nodeIds: string[]; directive: string };
    };

    expect(parsed.runScope.kind).toBe("nodes");
    expect(parsed.runScope.nodeIds).toEqual(selectedNodeIds);
    expect(parsed.runScope.directive).toContain("Focus this AI Implement run on the selected node scope");
    expect(parsed.contextManifest.selectedNodeIds).toEqual(selectedNodeIds);
    expect(parsed.contextManifest.includedNodeIds).toEqual(expect.arrayContaining(selectedNodeIds));
    expect(parsed.detailedNodes.map((node) => node.id)).toEqual(expect.arrayContaining(selectedNodeIds));
  });

  it("includes every root flow and nested subflow in project-scoped AI Implement context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-project-scope-"));
    const bundle = await ensureProject(root);
    const sourceNode = bundle.flows[0]!.nodes[0]!;
    await saveFlow(root, {
      id: "flow-secondary",
      name: "Secondary root",
      description: "A separate top-level architecture flow.",
      ignored: false,
      nodes: [
        { ...sourceNode, id: "node-secondary-root", title: "Secondary root node", subflowId: undefined },
        { ...sourceNode, id: "node-secondary-detail", title: "Secondary detail node", subflowId: "subflow-secondary-detail" }
      ],
      edges: [],
      subflows: [{ id: "subflow-secondary-detail", name: "Secondary detail", ignored: false }],
      groups: [],
      updatedAt: new Date().toISOString()
    });

    const context = await buildContext(root, "flow-main", undefined, "offline-manual", {
      kind: "project",
      flowId: "flow-main",
      nodeIds: [],
      label: "Project"
    }, { persistArtifacts: false });
    const parsed = JSON.parse(context.text) as {
      graphIndex: { projectGraph: Array<{ id: string; subflows: Array<{ id: string }>; nodes: Array<{ id: string; subflowId?: string }> }> };
      runScope: { kind: string };
    };
    const secondary = parsed.graphIndex.projectGraph.find((flow) => flow.id === "flow-secondary");

    expect(parsed.runScope.kind).toBe("project");
    expect(parsed.graphIndex.projectGraph.map((flow) => flow.id)).toEqual(expect.arrayContaining(["flow-main", "flow-secondary"]));
    expect(secondary?.subflows.map((subflow) => subflow.id)).toContain("subflow-secondary-detail");
    expect(secondary?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "node-secondary-root" }),
      expect.objectContaining({ id: "node-secondary-detail", subflowId: "subflow-secondary-detail" })
    ]));
  });

  it("includes compact best-effort implementation hints with an explicit advisory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-implementation-scope-"));
    const bundle = await ensureProject(root);
    const flow = bundle.flows[0]!;
    const node = flow.nodes[0]!;
    await updateNode(root, flow.id, {
      id: node.id,
      implementationScope: {
        source: "codebase-importer",
        analyzerVersion: 1,
        claims: [
          { relation: "own", kind: "file", path: "src/main/storage.ts" },
          { relation: "share", kind: "function", path: "src/main/storage.ts", symbol: "buildContext" }
        ]
      }
    }, "user");

    const context = await buildContext(root, flow.id, node.id, "offline-manual", undefined, { persistArtifacts: false });
    const parsed = JSON.parse(context.text) as {
      implementationScopePolicy: { authority: string; deterministicMeaning: string; guidance: string };
      selectedNode: { implementationScope?: { checkedAt?: string; claims: Array<{ relation: string; path: string }> } };
    };

    expect(parsed.implementationScopePolicy.authority).toBe("advisory-best-effort");
    expect(parsed.implementationScopePolicy.deterministicMeaning).toContain("does not guarantee semantic correctness");
    expect(parsed.implementationScopePolicy.guidance).toContain("never treat them as permissions");
    expect(parsed.implementationScopePolicy.guidance).toContain("before semantic matches");
    expect(parsed.implementationScopePolicy.guidance).toContain("checkedAt");
    expect(parsed.selectedNode.implementationScope?.checkedAt).toEqual(expect.any(String));
    expect(parsed.selectedNode.implementationScope?.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: "own", path: "src/main/storage.ts" }),
      expect.objectContaining({ relation: "share", path: "src/main/storage.ts" })
    ]));
  });

  it("adds no-scope AI Implement directives without selecting graph nodes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-no-scope-"));
    const bundle = await ensureProject(root);
    const flow = bundle.flows[0]!;

    const context = await buildContext(root, flow.id, undefined, "offline-manual", {
      kind: "no-scope",
      flowId: flow.id,
      nodeIds: [],
      label: "No scope"
    });
    const parsed = JSON.parse(context.text) as {
      contextManifest: { selectedNodeIds: string[] };
      runScope: { kind: string; nodeIds: string[]; directive: string };
    };

    expect(parsed.runScope.kind).toBe("no-scope");
    expect(parsed.runScope.nodeIds).toEqual([]);
    expect(parsed.runScope.directive).toContain("no-scope tactical edit");
    expect(parsed.runScope.directive).toContain("graph must be updated or approved first");
    expect(parsed.contextManifest.selectedNodeIds).toEqual([]);
  });

  it("keeps unresolved and pinned notes in context while filtering other resolved notes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-notes-"));
    await ensureProject(root);
    await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-orchestrator",
      kind: "user-note",
      author: "user",
      body: "Use the compact toolbar layout.",
      resolved: false
    });
    await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-orchestrator",
      kind: "system-note",
      author: "system",
      body: "Run run-ok succeeded. Routine completion note.",
      resolved: true
    });
    await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-orchestrator",
      kind: "user-note",
      author: "user",
      body: "Retired note that should not steer the agent.",
      resolved: true
    });
    await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-orchestrator",
      kind: "user-note",
      author: "user",
      body: "Pinned decision that should always steer this node.",
      resolved: true,
      pinned: true
    });
    await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-orchestrator",
      kind: "system-note",
      author: "system",
      body: "Run run-bad failed. Permission blocked verification.",
      resolved: false
    });

    const context = await buildContext(root, "flow-main", "node-orchestrator", "offline-manual");
    const parsed = JSON.parse(context.text) as { notes: { body: string }[]; memory: { decisions: string[] }[] };
    const bodies = parsed.notes.map((note) => note.body);

    expect(bodies[0]).toBe("Pinned decision that should always steer this node.");
    expect(bodies).toContain("Use the compact toolbar layout.");
    expect(bodies).toContain("Pinned decision that should always steer this node.");
    expect(bodies).toContain("Run run-bad failed. Permission blocked verification.");
    expect(bodies).not.toContain("Run run-ok succeeded. Routine completion note.");
    expect(bodies).not.toContain("Retired note that should not steer the agent.");
    expect(parsed.memory.some((record) => record.decisions.includes("Use the compact toolbar layout."))).toBe(true);
    expect(parsed.memory.some((record) => record.decisions.includes("Pinned decision that should always steer this node."))).toBe(true);
    expect(parsed.memory.some((record) => record.decisions.includes("Retired note that should not steer the agent."))).toBe(false);
  });

  it("lists node note attachments as metadata in build context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-attachments-"));
    await ensureProject(root);
    const attachmentPath = path.join(root, "note-reference.md");
    await writeFile(attachmentPath, "Attachment body should be read only on demand.", "utf8");
    const withNote = await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      kind: "user-note",
      author: "user",
      body: "Reference doc attached.",
      resolved: false
    });
    const noteId = withNote.notes.find((note) => note.body === "Reference doc attached.")!.id;
    await attachNodeReferences(root, {
      flowId: "flow-main",
      nodeId: "node-project",
      noteId,
      filePaths: [attachmentPath]
    });

    const context = await buildContext(root, "flow-main", "node-project", "offline-manual");
    const parsed = JSON.parse(context.text) as {
      attachmentPolicy: { agentGuidance: string };
      notes: Array<{ id: string; attachments: Array<{ title: string; mediaType: string; source: string }> }>;
    };
    const note = parsed.notes.find((item) => item.id === noteId);

    expect(parsed.attachmentPolicy.agentGuidance).toContain("archicode_project_read_artifact");
    expect(note?.attachments[0]).toMatchObject({
      title: "note-reference.md",
      mediaType: "text/markdown",
      source: "node-note-attachment"
    });
    expect(context.text).not.toContain("Attachment body should be read only on demand.");
  });

  it("keeps clean draft nodes summarized for whole-graph runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-clean-"));
    const bundle = await createProject(root, "website");
    const flow = bundle.flows[0]!;
    await saveFlow(root, {
      ...flow,
      nodes: flow.nodes.map((node) => ({
        ...node,
        stage: "draft",
        flags: [],
        locked: false
      }))
    });

    const context = await buildContext(root, "flow-main", undefined, "offline-manual");
    const parsed = JSON.parse(context.text) as {
      detailedNodes: { id: string }[];
      summarizedNodes: { id: string; flags: string[] }[];
    };

    expect(parsed.detailedNodes).toEqual([]);
    expect(parsed.summarizedNodes).toHaveLength(flow.nodes.length);
    expect(parsed.summarizedNodes.every((node) => !node.flags.includes("changed"))).toBe(true);
  });

  it("includes compact pending graph changes for meaningful node edits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-graph-change-node-"));
    await ensureProject(root);

    const updated = await updateNode(root, "flow-main", {
      id: "node-project",
      description: "User tightened the project model contract."
    }, "user");
    const context = await buildContext(root, "flow-main", undefined, "offline-manual");
    const parsed = JSON.parse(context.text) as {
      detailedNodes: { id: string }[];
      graphChangeHistory: { includedPendingLimit: number; fullLedgerPath: string; note: string };
      pendingGraphChanges: { kind: string; nodeIds: string[]; fieldPaths: string[]; snippets: { path: string; before?: string; after?: string }[] }[];
    };

    expect(updated.graphChanges.some((change) => change.kind === "node-updated" && change.nodeIds.includes("node-project"))).toBe(true);
    expect(parsed.graphChangeHistory.includedPendingLimit).toBe(128);
    expect(parsed.graphChangeHistory.fullLedgerPath).toBe(".archicode/graph-changes.jsonl");
    expect(parsed.graphChangeHistory.note).toContain("all historical graph change detail");
    expect(parsed.detailedNodes.some((node) => node.id === "node-project")).toBe(true);
    expect(parsed.pendingGraphChanges[0]).toMatchObject({
      kind: "node-updated",
      nodeIds: ["node-project"],
      fieldPaths: ["description"]
    });
    expect(parsed.pendingGraphChanges[0]?.snippets[0]?.after).toContain("User tightened");
  });

  it("retires pending graph changes whose node was deleted, keeping surviving ones pending", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-graph-change-obsolete-"));
    const bundle = await ensureProject(root);
    const flow = bundle.flows[0]!;

    await updateNode(root, "flow-main", {
      id: "node-canvas",
      description: "Doomed node summary before deletion."
    }, "user");
    await updateNode(root, "flow-main", {
      id: "node-project",
      description: "Surviving node summary update."
    }, "user");

    const beforeDelete = await loadProject(root);
    expect(beforeDelete.graphChanges.some((change) =>
      change.kind === "node-updated" && change.nodeIds.includes("node-canvas") && change.status === "pending"
    )).toBe(true);

    const current = beforeDelete.flows.find((item) => item.id === "flow-main")!;
    await saveFlow(root, {
      ...current,
      nodes: current.nodes.filter((node) => node.id !== "node-canvas"),
      edges: current.edges.filter((edge) => edge.source !== "node-canvas" && edge.target !== "node-canvas")
    });

    const afterDelete = await loadProject(root);
    const canvasChange = afterDelete.graphChanges.find((change) =>
      change.kind === "node-updated" && change.nodeIds.includes("node-canvas")
    );
    const projectChange = afterDelete.graphChanges.find((change) =>
      change.kind === "node-updated" && change.nodeIds.includes("node-project")
    );

    expect(canvasChange?.status).toBe("obsolete");
    expect(canvasChange?.resolvedAt).toBeDefined();
    expect(projectChange?.status).toBe("pending");

    const context = await buildContext(root, "flow-main", undefined, "offline-manual");
    const parsed = JSON.parse(context.text) as {
      pendingGraphChanges: { nodeIds: string[] }[];
    };
    expect(parsed.pendingGraphChanges.some((change) => change.nodeIds.includes("node-canvas"))).toBe(false);
  });

  it("archives resolved graph-change records older than the retention window and keeps pending ones", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-graph-change-retention-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, { ...bundle.project.settings, graphChangeRetention: "1day" });

    const ledgerPath = path.join(root, ".archicode", "graph-changes.jsonl");
    const oldResolved = {
      id: "gc-old", flowId: "flow-main", actor: "user", kind: "flow-updated",
      summary: "Old resolved change", nodeIds: [], edgeIds: [], subflowIds: [], fieldPaths: [], snippets: [],
      status: "implemented", createdAt: "2020-01-01T00:00:00.000Z", resolvedAt: "2020-01-02T00:00:00.000Z"
    };
    const recentPending = {
      id: "gc-recent", flowId: "flow-main", actor: "user", kind: "flow-updated",
      summary: "Recent pending change", nodeIds: [], edgeIds: [], subflowIds: [], fieldPaths: [], snippets: [],
      status: "pending", createdAt: new Date().toISOString()
    };
    await writeFile(ledgerPath, `${JSON.stringify(oldResolved)}\n${JSON.stringify(recentPending)}\n`, "utf8");

    const loaded = await loadProject(root);
    expect(loaded.graphChanges.some((change) => change.id === "gc-old")).toBe(false);
    expect(loaded.graphChanges.some((change) => change.id === "gc-recent")).toBe(true);

    const archive = await readFile(path.join(root, ".archicode", "graph-changes-archive.jsonl"), "utf8");
    expect(archive).toContain("gc-old");
    expect(archive).not.toContain("gc-recent");
  });

  it("never compacts the ledger when retention is disabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-graph-change-retention-never-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, { ...bundle.project.settings, graphChangeRetention: "never" });

    const ledgerPath = path.join(root, ".archicode", "graph-changes.jsonl");
    const oldResolved = {
      id: "gc-ancient", flowId: "flow-main", actor: "user", kind: "flow-updated",
      summary: "Ancient resolved change", nodeIds: [], edgeIds: [], subflowIds: [], fieldPaths: [], snippets: [],
      status: "implemented", createdAt: "2019-01-01T00:00:00.000Z", resolvedAt: "2019-01-02T00:00:00.000Z"
    };
    await writeFile(ledgerPath, `${JSON.stringify(oldResolved)}\n`, "utf8");

    const loaded = await loadProject(root);
    expect(loaded.graphChanges.some((change) => change.id === "gc-ancient")).toBe(true);
  });

  it("includes custom node properties and their reusable definitions in agent context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-custom-props-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      customNodeProperties: [{ id: "custom-owner", label: "Owner", type: "text" }]
    });
    await updateNode(root, "flow-main", {
      id: "node-project",
      customProperties: {
        "custom-owner": "Design systems"
      }
    }, "user");

    const context = await buildContext(root, "flow-main", "node-project", "offline-manual");
    const parsed = JSON.parse(context.text) as {
      project: { settings: { customNodeProperties: Array<{ id: string; label: string; type: string }> } };
      selectedNode: { customProperties: Record<string, string> };
    };

    expect(parsed.project.settings.customNodeProperties).toContainEqual({ id: "custom-owner", label: "Owner", type: "text" });
    expect(parsed.selectedNode.customProperties["custom-owner"]).toBe("Design systems");
  });

  it("includes attached node rules and reusable rule definitions in agent context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-node-rules-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      nodeRules: [{
        id: "rule-devops",
        title: "DevOps deploy rule",
        body: "Use the existing CI pipeline and avoid manual deployment steps.",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }]
    });
    await updateNode(root, "flow-main", {
      id: "node-project",
      ruleIds: ["rule-devops"]
    }, "user");

    const context = await buildContext(root, "flow-main", "node-project", "offline-manual");
    const parsed = JSON.parse(context.text) as {
      project: { settings: { nodeRules: Array<{ id: string; title: string; body: string }> } };
      selectedNode: { ruleIds: string[]; attachedRules: Array<{ id: string; title: string; body: string }> };
      detailedNodes: Array<{ id: string; attachedRules?: Array<{ id: string; body: string }> }>;
    };

    expect(parsed.project.settings.nodeRules).toContainEqual(expect.objectContaining({
      id: "rule-devops",
      title: "DevOps deploy rule"
    }));
    expect(parsed.selectedNode.ruleIds).toEqual(["rule-devops"]);
    expect(parsed.selectedNode.attachedRules[0]?.body).toContain("existing CI pipeline");
    expect(parsed.detailedNodes.find((node) => node.id === "node-project")?.attachedRules?.[0]?.id).toBe("rule-devops");
  });

  it("removes deleted node rules from every node attachment", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-node-rule-delete-"));
    const bundle = await ensureProject(root);
    const now = new Date().toISOString();
    const deletedRule = {
      id: "rule-delete-me",
      title: "Temporary rule",
      body: "Remove this guidance everywhere.",
      createdAt: now,
      updatedAt: now
    };
    const keptRule = {
      id: "rule-keep-me",
      title: "Permanent rule",
      body: "Keep this guidance attached.",
      createdAt: now,
      updatedAt: now
    };

    await updateProjectSettings(root, {
      ...bundle.project.settings,
      nodeRules: [deletedRule, keptRule]
    });
    await updateNode(root, "flow-main", {
      id: "node-project",
      ruleIds: [deletedRule.id, keptRule.id]
    }, "user");
    await saveFlow(root, {
      ...bundle.flows[0]!,
      id: "flow-extra",
      name: "Extra flow",
      edges: [],
      subflows: [],
      groups: [],
      nodes: [{
        ...bundle.flows[0]!.nodes[0]!,
        id: "node-extra",
        title: "Extra node",
        ruleIds: [deletedRule.id],
        updatedAt: now
      }],
      updatedAt: now
    });

    const latest = await ensureProject(root);
    const updated = await updateProjectSettings(root, {
      ...latest.project.settings,
      nodeRules: [keptRule]
    });
    const mainNode = updated.flows.find((flow) => flow.id === "flow-main")?.nodes.find((node) => node.id === "node-project");
    const extraNode = updated.flows.find((flow) => flow.id === "flow-extra")?.nodes.find((node) => node.id === "node-extra");

    expect(updated.project.settings.nodeRules?.map((rule) => rule.id)).toEqual([keptRule.id]);
    expect(mainNode?.ruleIds).toEqual([keptRule.id]);
    expect(extraNode?.ruleIds).toBeUndefined();
  });

  it("rejects changing a custom node property type after creation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-custom-prop-type-lock-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      customNodeProperties: [{ id: "custom-owner", label: "Owner", type: "text" }]
    });
    const updated = await ensureProject(root);

    await expect(updateProjectSettings(root, {
      ...updated.project.settings,
      customNodeProperties: [{ id: "custom-owner", label: "Owner", type: "color" }]
    })).rejects.toThrow(/type cannot be changed/);
  });

  it("uses edge-only graph changes to pull affected endpoints into context without raw graph spam", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-graph-change-edge-"));
    const bundle = await ensureProject(root);
    const flow = bundle.flows[0]!;
    const edge = {
      id: "edge-user-added",
      source: "node-project",
      target: "node-orchestrator",
      label: "new dependency"
    };

    await saveFlow(root, {
      ...flow,
      nodes: flow.nodes.map((node) => ({ ...node, flags: [] })),
      edges: [...flow.edges, edge]
    }, { recordGraphChanges: true, actor: "user" });
    const context = await buildContext(root, "flow-main", undefined, "offline-manual");
    const parsed = JSON.parse(context.text) as {
      detailedNodes: { id: string }[];
      pendingGraphChanges: { kind: string; edgeIds: string[]; snippets: unknown[] }[];
    };

    expect(parsed.detailedNodes.map((node) => node.id)).toEqual(expect.arrayContaining(["node-project", "node-orchestrator"]));
    expect(parsed.pendingGraphChanges.some((change) =>
      change.kind === "edge-created" &&
      change.edgeIds.includes("edge-user-added") &&
      change.snippets.length <= 3
    )).toBe(true);
  });

  it("excludes ignored graph items from the working context while listing them compactly", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-ignored-"));
    const bundle = await ensureProject(root);
    const flow = bundle.flows[0]!;
    await saveFlow(root, {
      ...flow,
      nodes: flow.nodes.map((node) => node.id === "node-canvas"
        ? { ...node, ignored: true }
        : node)
    });
    await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-canvas",
      kind: "llm-question",
      author: "llm",
      body: "Ignored node question should not steer the run.",
      resolved: false
    });

    const context = await buildContext(root, "flow-main", undefined, "offline-manual");
    const parsed = JSON.parse(context.text) as {
      ignoredGraph: { nodes: { id: string; title: string }[] };
      detailedNodes: { id: string }[];
      summarizedNodes: { id: string }[];
      notes: { body: string }[];
      graphIndex: { flow: { edges: { source: string; target: string }[] } };
    };

    expect(parsed.ignoredGraph.nodes.some((node) => node.id === "node-canvas")).toBe(true);
    expect(parsed.detailedNodes.some((node) => node.id === "node-canvas")).toBe(false);
    expect(parsed.summarizedNodes.some((node) => node.id === "node-canvas")).toBe(false);
    expect(parsed.notes.some((note) => note.body.includes("Ignored node question"))).toBe(false);
    expect(parsed.graphIndex.flow.edges.some((edge) => edge.source === "node-canvas" || edge.target === "node-canvas")).toBe(false);
  });

  it("excludes ignored subflows from the working context while listing them compactly", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-ignored-subflow-"));
    const bundle = await ensureProject(root);
    const flow = bundle.flows[0]!;
    await saveFlow(root, {
      ...flow,
      subflows: flow.subflows.map((subflow) => subflow.id === "subflow-json" ? { ...subflow, ignored: true } : subflow),
      nodes: flow.nodes.map((node) => node.id === "node-canvas" ? { ...node, subflowId: "subflow-json" } : node)
    });
    await addNote(root, {
      flowId: "flow-main",
      nodeId: "node-canvas",
      kind: "llm-question",
      author: "llm",
      body: "Ignored subflow question should not steer the run.",
      resolved: false
    });

    const context = await buildContext(root, "flow-main", undefined, "offline-manual");
    const parsed = JSON.parse(context.text) as {
      ignoredGraph: { subflows: { id: string }[]; nodes: { id: string; subflowIgnored: boolean }[] };
      detailedNodes: { id: string }[];
      summarizedNodes: { id: string }[];
      notes: { body: string }[];
      graphIndex: { flow: { subflows: { id: string }[]; edges: { source: string; target: string }[] } };
    };

    expect(parsed.ignoredGraph.subflows.some((subflow) => subflow.id === "subflow-json")).toBe(true);
    expect(parsed.ignoredGraph.nodes.some((node) => node.id === "node-canvas" && node.subflowIgnored)).toBe(true);
    expect(parsed.detailedNodes.some((node) => node.id === "node-canvas")).toBe(false);
    expect(parsed.summarizedNodes.some((node) => node.id === "node-canvas")).toBe(false);
    expect(parsed.notes.some((note) => note.body.includes("Ignored subflow question"))).toBe(false);
    expect(parsed.graphIndex.flow.subflows.some((subflow) => subflow.id === "subflow-json")).toBe(false);
    expect(parsed.graphIndex.flow.edges.some((edge) => edge.source === "node-canvas" || edge.target === "node-canvas")).toBe(false);
  });

  it("blocks context creation for ignored run scopes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-ignored-scope-"));
    const bundle = await ensureProject(root);
    const flow = bundle.flows[0]!;
    await saveFlow(root, {
      ...flow,
      nodes: flow.nodes.map((node) => node.id === "node-canvas"
        ? { ...node, ignored: true }
        : node)
    });

    await expect(buildContext(root, "flow-main", "node-canvas", "offline-manual")).rejects.toThrow(/ignored and outside the agent working set/);

    const reloaded = (await ensureProject(root)).flows[0]!;
    await saveFlow(root, {
      ...reloaded,
      subflows: reloaded.subflows.map((subflow) => subflow.id === "subflow-json" ? { ...subflow, ignored: true } : subflow),
      nodes: reloaded.nodes.map((node) => node.id === "node-orchestrator" ? { ...node, subflowId: "subflow-json" } : node)
    });
    await expect(buildContext(root, "flow-main", "node-orchestrator", "offline-manual")).rejects.toThrow(/ignored and outside the agent working set/);

    await saveFlow(root, { ...reloaded, ignored: true });
    await expect(buildContext(root, "flow-main", undefined, "offline-manual")).rejects.toThrow(/Flow ".*" is ignored/);
  });

  it("includes project conventions and missing recommendations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-context-conventions-"));
    await ensureProject(root);
    await writeFile(path.join(root, ".gitignore"), "node_modules\n.env\n.archicode/artifacts\n", "utf8");

    const context = await buildContext(root, "flow-main", "node-orchestrator", "offline-manual");
    const parsed = JSON.parse(context.text) as {
      projectConventions?: {
        missingRecommended?: string[];
        files?: { path: string; exists: boolean; excerpt?: string }[];
      };
    };

    expect(parsed.projectConventions?.files?.find((file) => file.path === ".gitignore")?.exists).toBe(true);
    expect(parsed.projectConventions?.files?.find((file) => file.path === ".gitignore")?.excerpt).toContain("node_modules");
    expect(parsed.projectConventions?.missingRecommended).toContain("AGENTS.md");
  });
});
