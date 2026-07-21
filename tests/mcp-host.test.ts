import http from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addNote, attachNodeReferences } from "../src/main/storage/notes";
import { ensureExternalMcpHostToken, ensureFixtureProject, loadProject, updateNode, updateProjectSettings } from "../src/main/storage/projectStore";
import { getExternalMcpHostStatus, setExternalMcpCanvasCaptureRequester, setExternalMcpProjectUpdatePublisher, stopExternalMcpHost, syncExternalMcpHost } from "../src/main/mcpHost";
import { sanitizeExternalValue } from "../src/shared/redaction";
import { codeKnowledgeSnapshotSchema } from "../src/shared/codeKnowledge";
import { writeCodeKnowledgeSnapshot } from "../src/main/importer/knowledgeSnapshot";

function hostedCodeKnowledgeFixture() {
  return codeKnowledgeSnapshotSchema.parse({
    version: 1,
    generatedAt: "2026-07-13T10:00:00.000Z",
    source: "codebase-import",
    nodes: [
      { id: "file-main", kind: "file", label: "main.ts", path: "src/main.ts", language: "typescript", community: "Application" },
      { id: "symbol-answer", kind: "symbol", label: "answer", path: "src/main.ts", line: 1, symbolKind: "variable", language: "typescript", community: "Application" }
    ],
    edges: [{ id: "contains-answer", source: "file-main", target: "symbol-answer", kind: "contains", evidence: { origin: "extracted", confidence: 1, relationKinds: ["contains"], locations: [{ path: "src/main.ts", line: 1 }], verification: "verified", freshness: "current" } }],
    communities: [{ id: "Application", label: "Application", nodeCount: 2 }],
    stats: { files: 1, symbols: 1, dependencies: 0, calls: 0, availableNodes: 2, availableEdges: 1, truncated: false, unresolvedImports: 0, resolutionRate: 1 }
  });
}

describe("Hosted ArchiCode MCP", () => {
  afterEach(async () => {
    setExternalMcpCanvasCaptureRequester(null);
    setExternalMcpProjectUpdatePublisher(null);
    await stopExternalMcpHost();
  });

  it("keeps hosted MCP disabled by default and stores tokens only in local state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-mcp-host-default-"));
    const bundle = await ensureFixtureProject(root);
    const token = await ensureExternalMcpHostToken(root);
    const shared = await readFile(path.join(root, ".archicode", "project.json"), "utf8");
    const local = await readFile(path.join(root, ".archicode", "local.json"), "utf8");

    expect(bundle.project.settings.externalMcpHost.enabled).toBe(false);
    expect(token).toHaveLength(43);
    expect(shared).not.toContain(token);
    expect(local).toContain(token);
  });

  it("requires a bearer token and exposes tools to authenticated clients", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-mcp-host-auth-"));
    const bundle = await enableHost(root, await freePort());
    const status = await getExternalMcpHostStatus(root, bundle.project.settings);

    expect(status.codexConfig).toContain("Direct headers:");
    expect(status.codexConfig).toContain(`Authorization: Bearer ${status.token}`);
    expect(status.codexConfig).toContain("default_tools_approval_mode: auto");
    expect(status.codexConfig).toContain("Headers from environment variables: leave empty");
    expect(status.codexConfig).not.toContain("Available MCP prompts");
    expect(status.codexConfig).not.toContain("archicode_coding_orientation");

    const rejected = await fetch(status.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    expect(rejected.status).toBe(401);

    const rpc = await connectRpc(status.endpoint, status.token!);
    const tools = await rpc("tools/list");
    const toolNames = tools.result.tools.map((tool: { name: string }) => tool.name);

    expect(toolNames).toContain("archicode_about");
    expect(toolNames).toContain("archicode_get_project");
    expect(toolNames).toContain("archicode_get_scoped_change_context");
    expect(toolNames).toContain("archicode_get_rules");
    expect(toolNames).toContain("archicode_query_code_graph");
    expect(toolNames).toContain("archicode_capture_canvas");
    expect(toolNames).toContain("archicode_update_node");
    expect(toolNames).toContain("archicode_update_subflow");
    expect(toolNames).toEqual(expect.arrayContaining([
      "archicode_create_subflow",
      "archicode_delete_subflow",
      "archicode_link_node_subflow",
      "archicode_create_group",
      "archicode_update_group",
      "archicode_delete_group",
      "archicode_delete_note",
      "archicode_run_acceptance_checks",
      "archicode_upsert_run_profile",
      "archicode_get_graph_changes",
      "archicode_list_incidents",
      "archicode_list_runtime_services"
    ]));
    expect(tools.result.tools.find((tool: { name: string }) => tool.name === "archicode_get_scoped_change_context")?.inputSchema.properties.persistArtifacts).toBeTruthy();
    expect(tools.result.tools.find((tool: { name: string }) => tool.name === "archicode_create_edge")?.inputSchema.properties.edge.additionalProperties).toBe(false);
    expect(tools.result.tools.find((tool: { name: string }) => tool.name === "archicode_add_note")?.inputSchema.properties.note.required).toContain("body");

    const prompts = await rpc("prompts/list");
    expect(prompts.result.prompts.map((prompt: { name: string }) => prompt.name)).toContain("archicode_coding_orientation");
    const prompt = await rpc("prompts/get", {
      name: "archicode_coding_orientation",
      arguments: { scope: "hosted MCP tests" }
    });
    expect(prompt.result.messages[0].content.text).toContain("archicode_get_scoped_change_context");
  });

  it("returns hosted canvas screenshots as MCP image content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-mcp-host-canvas-"));
    const bundle = await enableHost(root, await freePort());
    const flow = bundle.flows[0]!;
    const node = flow.nodes[0]!;
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
    setExternalMcpCanvasCaptureRequester(async (projectRoot, request) => ({
      requestId: "capture-test",
      projectRoot,
      flowId: request.flowId,
      subflowId: request.subflowId ?? null,
      nodeIds: request.nodeIds,
      groupIds: request.groupIds,
      label: request.label,
      mimeType: "image/png",
      data: png,
      width: 800,
      height: 600,
      capturedAt: "2026-07-21T10:00:00.000Z"
    }));
    const status = await getExternalMcpHostStatus(root, bundle.project.settings);
    const rpc = await connectRpc(status.endpoint, status.token!);

    const result = await rpc("tools/call", {
      name: "archicode_capture_canvas",
      arguments: {
        flowId: flow.id,
        nodeIds: [node.id],
        label: "node focus"
      }
    });

    expect(result.result.isError).not.toBe(true);
    const metadata = JSON.parse(result.result.content[0].text);
    expect(metadata).toMatchObject({
      flowId: flow.id,
      nodeIds: [node.id],
      label: "node focus",
      mimeType: "image/png",
      width: 800,
      height: 600
    });
    expect(metadata.data).toBeUndefined();
    expect(result.result.content[1]).toMatchObject({ type: "image", data: png, mimeType: "image/png" });
  });

  it("exposes bounded local code graph queries over hosted MCP", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-mcp-host-code-graph-"));
    const bundle = await enableHost(root, await freePort());
    await writeCodeKnowledgeSnapshot(root, hostedCodeKnowledgeFixture());
    const status = await getExternalMcpHostStatus(root, bundle.project.settings);
    const rpc = await connectRpc(status.endpoint, status.token!);

    const result = await rpc("tools/call", { name: "archicode_query_code_graph", arguments: { action: "neighbors", source: "src/main.ts", maxResults: 2 } });
    expect(result.result.isError).not.toBe(true);
    const payload = JSON.parse(result.result.content[0].text);
    expect(payload).toMatchObject({ available: true, action: "neighbors", bounded: true, limit: 2 });
    expect(payload.nodes).toHaveLength(2);
    expect(payload.edges).toHaveLength(1);
  });

  it("renames detail flows over hosted MCP", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-mcp-host-subflow-rename-"));
    const bundle = await enableHost(root, await freePort());
    const flow = bundle.flows[0]!;
    const subflow = flow.subflows[0]!;
    const status = await getExternalMcpHostStatus(root, bundle.project.settings);
    const rpc = await connectRpc(status.endpoint, status.token!);

    const result = await rpc("tools/call", {
      name: "archicode_update_subflow",
      arguments: {
        flowId: flow.id,
        subflowId: subflow.id,
        patch: { name: "Hosted MCP Detail Flow" }
      }
    });
    const updated = await loadProject(root);

    expect(result.result.isError).not.toBe(true);
    expect(updated.flows[0]?.subflows.find((item) => item.id === subflow.id)?.name).toBe("Hosted MCP Detail Flow");
    expect(updated.graphChanges.some((change) =>
      change.kind === "subflow-updated" &&
      change.actor === "accepted-research" &&
      change.subflowIds.includes(subflow.id)
    )).toBe(true);
  });

  it("advertises ArchiCode and exposes smart scoped context resources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-mcp-host-context-"));
    const bundle = await enableHost(root, await freePort());
    const status = await getExternalMcpHostStatus(root, bundle.project.settings);
    const flow = bundle.flows[0]!;
    const rpc = await connectRpc(status.endpoint, status.token!);

    const resources = await rpc("resources/list");
    const resourceUris = resources.result.resources.map((resource: { uri: string }) => resource.uri);
    expect(resourceUris).toContain("archicode://about");
    expect(resourceUris).toContain("archicode://context/project");
    expect(resourceUris).toContain(`archicode://context/flow/${encodeURIComponent(flow.id)}`);
    expect(resourceUris).toContain("archicode://incidents");
    expect(resourceUris).toContain("archicode://runtime-services");

    const templates = await rpc("resources/templates/list");
    const templateUris = templates.result.resourceTemplates.map((template: { uriTemplate: string }) => template.uriTemplate);
    expect(templateUris).toContain("archicode://node/{flowId}/{nodeId}");
    expect(templateUris).toContain("archicode://subflow/{flowId}/{subflowId}");
    expect(templateUris).toContain("archicode://context/nodes/{flowId}/{nodeIds}");

    const aboutResource = await rpc("resources/read", { uri: "archicode://about" });
    const about = JSON.parse(aboutResource.result.contents[0].text);
    expect(about.archicode.name).toBe("ArchiCode");
    expect(about.archicode.capabilityVersion).toBe("2026-07-17.3");
    expect(about.archicode.capabilities.researchChat.can.join(" ")).toContain("Sherlock");
    expect(about.archicode.currentProjectOptions.reviewAndApproval.codeReviewMode).toBe("auto-apply");
    expect(about.guidance.bestContextTool).toBe("archicode_get_scoped_change_context");
    expect(about.guidance.mutationSurface.mode).toBe("direct validated apply");
    expect(about.guidance.mutationSurface.availableTools).toContain("archicode_update_node");
    expect(about.guidance.mutationSurface.limitation).toContain("Only listed hosted MCP mutations are callable");
    expect(about.prompts.map((prompt: { name: string }) => prompt.name)).toContain("archicode_coding_orientation");

    const contextResource = await rpc("resources/read", { uri: `archicode://context/flow/${encodeURIComponent(flow.id)}` });
    const context = JSON.parse(contextResource.result.contents[0].text);
    expect(context.context.runScope.kind).toBe("flow");
    expect(context.context.pendingGraphChanges).toBeDefined();
    expect(context.artifacts).toEqual([]);
    expect(context.summary.items.map((item: { label: string }) => item.label)).toContain("pending graph changes");
  });

  it("exposes reusable node rules and node attachments over hosted MCP", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-mcp-host-rules-"));
    const initial = await ensureFixtureProject(root);
    const flow = initial.flows[0]!;
    const node = flow.nodes[0]!;
    const port = await freePort();
    const rule = {
      id: "rule-design-accessibility",
      title: "Design accessibility",
      body: "Preserve keyboard focus, semantic labels, and visible error states.",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await updateProjectSettings(root, {
      ...initial.project.settings,
      nodeRules: [rule],
      externalMcpHost: {
        ...initial.project.settings.externalMcpHost,
        enabled: true,
        port
      }
    });
    await updateNode(root, flow.id, { id: node.id, ruleIds: [rule.id] }, "user");
    const bundle = await loadProject(root);
    await syncExternalMcpHost(root, bundle.project.settings);
    const status = await getExternalMcpHostStatus(root, bundle.project.settings);
    const rpc = await connectRpc(status.endpoint, status.token!);

    const rulesResult = await rpc("tools/call", {
      name: "archicode_get_rules",
      arguments: { flowId: flow.id, nodeId: node.id }
    });
    expect(rulesResult.result.isError).not.toBe(true);
    const rules = JSON.parse(rulesResult.result.content[0].text);
    expect(rules.rules[0]).toMatchObject({ id: rule.id, title: rule.title, body: rule.body });
    expect(rules.selectedNode.attachedRules[0]).toMatchObject({ id: rule.id, title: rule.title, body: rule.body });
    expect(rules.attachments[0]).toMatchObject({ ruleId: rule.id, flowId: flow.id, nodeId: node.id });

    const nodeResult = await rpc("tools/call", {
      name: "archicode_get_node",
      arguments: { flowId: flow.id, nodeId: node.id }
    });
    expect(nodeResult.result.isError).not.toBe(true);
    const hostedNode = JSON.parse(nodeResult.result.content[0].text);
    expect(hostedNode.attachedRules[0]).toMatchObject({ id: rule.id, title: rule.title, body: rule.body });

    const rulesResource = await rpc("resources/read", { uri: "archicode://rules" });
    const resourceRules = JSON.parse(rulesResource.result.contents[0].text);
    expect(resourceRules.rules[0].id).toBe(rule.id);
  });

  it("exposes node note attachments as artifact metadata over hosted MCP", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-mcp-host-note-attachments-"));
    const initial = await ensureFixtureProject(root);
    const flow = initial.flows[0]!;
    const node = flow.nodes[0]!;
    const attachmentPath = path.join(root, "note-notes.md");
    await writeFile(attachmentPath, "Note attachment details for MCP agents.\nAPI_KEY=super-secret-artifact-value", "utf8");
    const withNote = await addNote(root, {
      flowId: flow.id,
      nodeId: node.id,
      kind: "user-note",
      author: "user",
      body: "See attached notes.",
      resolved: false
    });
    const note = withNote.notes.find((item) => item.body === "See attached notes.")!;
    await attachNodeReferences(root, {
      flowId: flow.id,
      nodeId: node.id,
      noteId: note.id,
      filePaths: [attachmentPath]
    });
    const bundle = await enableHost(root, await freePort());
    const status = await getExternalMcpHostStatus(root, bundle.project.settings);
    const rpc = await connectRpc(status.endpoint, status.token!);

    const nodeResult = await rpc("tools/call", {
      name: "archicode_get_node",
      arguments: { flowId: flow.id, nodeId: node.id }
    });
    expect(nodeResult.result.isError).not.toBe(true);
    const hostedNode = JSON.parse(nodeResult.result.content[0].text);
    const hostedNote = hostedNode.notes.find((item: { id: string }) => item.id === note.id);
    expect(hostedNote.attachmentIds).toHaveLength(1);
    expect(hostedNote.attachments[0]).toMatchObject({
      id: hostedNote.attachmentIds[0],
      title: "note-notes.md",
      mediaType: "text/markdown",
      nodeId: node.id,
      noteId: note.id
    });
    expect(hostedNode.artifacts[0]).toMatchObject({
      id: hostedNote.attachmentIds[0],
      mediaType: "text/markdown",
      noteId: note.id
    });

    const artifactResult = await rpc("tools/call", {
      name: "archicode_read_artifact",
      arguments: { artifactId: hostedNote.attachmentIds[0] }
    });
    expect(artifactResult.result.isError).not.toBe(true);
    const artifact = JSON.parse(artifactResult.result.content[0].text);
    expect(artifact).toMatchObject({
      id: hostedNote.attachmentIds[0],
      mediaType: "text/markdown",
      noteId: note.id
    });
    expect(artifact.text).toContain("Note attachment details for MCP agents.");
    expect(artifact.text).toContain("API_KEY=[redacted]");
    expect(artifact.text).not.toContain("super-secret-artifact-value");
    expect(artifact.redacted).toBe(true);
    const artifactPathStem = String(hostedNote.attachments[0].path ?? hostedNode.artifacts[0].path)
      .split("/")
      .pop()!
      .replace(/\.[^.]+$/, "");

    const aliasArtifactResult = await rpc("tools/call", {
      name: "archicode_read_artifact",
      arguments: { artifactId: artifactPathStem }
    });
    expect(aliasArtifactResult.result.isError).not.toBe(true);
    const aliasArtifact = JSON.parse(aliasArtifactResult.result.content[0].text);
    expect(aliasArtifact).toMatchObject({
      id: hostedNote.attachmentIds[0],
      path: expect.stringContaining("note-notes.md")
    });
  });

  it("surfaces port conflicts as host status errors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-mcp-host-conflict-"));
    const blocker = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("occupied");
    });
    const port = await listenOnFreePort(blocker);
    try {
      const bundle = await enableHost(root, port);
      const status = await getExternalMcpHostStatus(root, bundle.project.settings);

      expect(status.enabled).toBe(true);
      expect(status.running).toBe(false);
      expect(status.error).toMatch(/EADDRINUSE|address already in use/i);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("applies validated graph mutations and records graph changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-mcp-host-tools-"));
    const bundle = await enableHost(root, await freePort());
    const status = await getExternalMcpHostStatus(root, bundle.project.settings);
    const flow = bundle.flows[0]!;
    const node = flow.nodes[0]!;
    const existingPairs = new Set(flow.edges.map((edge) => `${edge.source}\0${edge.target}`));
    const pair = flow.nodes.flatMap((source) =>
      flow.nodes.filter((target) => target.id !== source.id && !existingPairs.has(`${source.id}\0${target.id}`)).map((target) => ({ source, target }))
    )[0]!;
    const rpc = await connectRpc(status.endpoint, status.token!);
    const updates: Array<{ projectRoot: string; action: string }> = [];
    setExternalMcpProjectUpdatePublisher((projectRoot, payload) => {
      updates.push({ projectRoot, action: payload.action });
    });

    const updateResult = await rpc("tools/call", {
      name: "archicode_update_node",
      arguments: {
        flowId: flow.id,
        patch: { id: node.id, description: "Updated through hosted MCP." }
      }
    });
    const createEdgeResult = await rpc("tools/call", {
      name: "archicode_create_edge",
      arguments: {
        flowId: flow.id,
        edge: { id: "edge-hosted-mcp", source: pair.source.id, target: pair.target.id, label: "hosted" }
      }
    });
    const deleteEdgeResult = await rpc("tools/call", {
      name: "archicode_delete_edge",
      arguments: {
        flowId: flow.id,
        edgeId: "edge-hosted-mcp"
      }
    });

    expect(updateResult.result.isError).not.toBe(true);
    expect(createEdgeResult.result.isError).not.toBe(true);
    expect(deleteEdgeResult.result.isError).not.toBe(true);
    expect(updates).toEqual(expect.arrayContaining([
      { projectRoot: root, action: "archicode_update_node" },
      { projectRoot: root, action: "archicode_create_edge" },
      { projectRoot: root, action: "archicode_delete_edge" }
    ]));

    const scopedContextResult = await rpc("tools/call", {
      name: "archicode_get_scoped_change_context",
      arguments: {
        scopeKind: "nodes",
        flowId: flow.id,
        nodeIds: [node.id]
      }
    });
    expect(scopedContextResult.result.isError).not.toBe(true);
    const scopedContext = JSON.parse(scopedContextResult.result.content[0].text);
    expect(scopedContext.context.runScope.kind).toBe("nodes");
    expect(scopedContext.context.runScope.directive).toContain("selected node scope");
    expect(scopedContext.context.pendingGraphChanges.map((change: { kind: string }) => change.kind)).toContain("node-updated");
    expect(scopedContext.artifacts).toEqual([]);

    const updated = await loadProject(root);
    const updatedNode = updated.flows[0]!.nodes.find((item) => item.id === node.id)!;
    expect(updatedNode.description).toBe("Updated through hosted MCP.");
    expect(updated.graphChanges.map((change) => change.kind)).toEqual(
      expect.arrayContaining(["node-updated", "edge-created", "edge-deleted"])
    );
  });

  it("omits or redacts configured MCP secrets from tools and resources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-mcp-host-redaction-"));
    const hosted = await enableHost(root, await freePort());
    const secret = "hosted-mcp-secret-value";
    const updated = await updateProjectSettings(root, {
      ...hosted.project.settings,
      mcp: {
        ...hosted.project.settings.mcp,
        servers: [{
          id: "secret-server",
          label: "Secret server",
          transport: "streamable-http",
          url: "https://example.invalid/mcp",
          env: [{ name: "API_TOKEN", value: secret }],
          headers: [{ name: "Authorization", value: `Bearer ${secret}` }],
          args: [],
          enabled: true,
          trusted: true,
          source: "project",
          tools: [],
          resources: [],
          prompts: []
        }]
      }
    });
    const status = await getExternalMcpHostStatus(root, updated.project.settings);
    const rpc = await connectRpc(status.endpoint, status.token!);

    const projectResult = await rpc("tools/call", { name: "archicode_get_project", arguments: {} });
    const projectText = projectResult.result.content[0].text as string;
    expect(projectText).not.toContain(secret);

    const resourceResult = await rpc("resources/read", { uri: "archicode://project" });
    const resourceText = resourceResult.result.contents[0].text as string;
    expect(resourceText).not.toContain(secret);

    const direct = sanitizeExternalValue({ mcp: { servers: [{ env: [{ name: "API_TOKEN", value: secret }], headers: [{ name: "Authorization", value: `Bearer ${secret}` }] }] } });
    expect(JSON.stringify(direct.value)).not.toContain(secret);
    expect(JSON.stringify(direct.value)).toContain("[redacted]");
    expect(direct.redacted).toBe(true);
  });

  it("supports structural graph, note, and run-profile lifecycle operations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-mcp-host-structure-"));
    const bundle = await enableHost(root, await freePort());
    const flow = bundle.flows[0]!;
    const node = flow.nodes[0]!;
    const status = await getExternalMcpHostStatus(root, bundle.project.settings);
    const rpc = await connectRpc(status.endpoint, status.token!);

    for (const [name, argumentsValue] of [
      ["archicode_create_group", { flowId: flow.id, group: { id: "group-hosted", name: "Hosted group", color: "#445566" } }],
      ["archicode_update_group", { flowId: flow.id, groupId: "group-hosted", patch: { name: "Hosted group updated" } }],
      ["archicode_create_subflow", { flowId: flow.id, subflow: { id: "subflow-hosted", name: "Hosted detail" } }],
      ["archicode_link_node_subflow", { flowId: flow.id, nodeId: node.id, subflowId: "subflow-hosted" }],
      ["archicode_link_node_subflow", { flowId: flow.id, nodeId: node.id, subflowId: null }],
      ["archicode_upsert_run_profile", { mode: "create", profile: { id: "profile-hosted", label: "Hosted target", kind: "generic", runCommand: "npm run dev" } }]
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await rpc("tools/call", { name, arguments: argumentsValue });
      expect(result.result.isError, `${name}: ${result.result.content?.[0]?.text ?? ""}`).not.toBe(true);
      const payload = JSON.parse(result.result.content[0].text);
      expect(payload.bundle).toBeUndefined();
      expect(payload.project.id).toBe(bundle.project.id);
    }

    const searchResult = await rpc("tools/call", { name: "archicode_search_graph", arguments: { query: "Hosted group updated" } });
    const search = JSON.parse(searchResult.result.content[0].text);
    expect(search).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "group", id: "group-hosted" })]));

    const subflowResource = await rpc("resources/read", { uri: `archicode://subflow/${encodeURIComponent(flow.id)}/subflow-hosted` });
    expect(JSON.parse(subflowResource.result.contents[0].text).subflow.name).toBe("Hosted detail");
    const nodeResource = await rpc("resources/read", { uri: `archicode://node/${encodeURIComponent(flow.id)}/${encodeURIComponent(node.id)}` });
    expect(JSON.parse(nodeResource.result.contents[0].text).node.id).toBe(node.id);

    const noteResult = await rpc("tools/call", {
      name: "archicode_add_note",
      arguments: { note: { flowId: flow.id, nodeId: node.id, kind: "user-note", author: "user", body: "Temporary hosted note" } }
    });
    const createdNote = JSON.parse(noteResult.result.content[0].text);
    const deleteNoteResult = await rpc("tools/call", { name: "archicode_delete_note", arguments: { noteId: createdNote.mutation.noteId } });
    expect(deleteNoteResult.result.isError).not.toBe(true);

    for (const [name, argumentsValue] of [
      ["archicode_delete_subflow", { flowId: flow.id, subflowId: "subflow-hosted" }],
      ["archicode_delete_group", { flowId: flow.id, groupId: "group-hosted" }]
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await rpc("tools/call", { name, arguments: argumentsValue });
      expect(result.result.isError, `${name}: ${result.result.content?.[0]?.text ?? ""}`).not.toBe(true);
    }

    const updated = await loadProject(root);
    expect(updated.flows[0]?.groups.some((group) => group.id === "group-hosted")).toBe(false);
    expect(updated.flows[0]?.subflows.some((subflow) => subflow.id === "subflow-hosted")).toBe(false);
    expect(updated.project.settings.runTargetProfiles.some((profile) => profile.id === "profile-hosted")).toBe(true);
    expect(updated.notes.some((note) => note.body === "Temporary hosted note")).toBe(false);
    expect(updated.graphChanges.map((change) => change.kind)).toEqual(expect.arrayContaining([
      "group-created", "group-updated", "group-deleted", "subflow-created", "node-subflow-linked", "subflow-deleted"
    ]));
    expect(updated.graphChanges.filter((change) =>
      (change.kind === "group-created" || change.kind === "group-updated") && change.groupIds.includes("group-hosted")
    ).every((change) => change.status === "obsolete")).toBe(true);
    expect(updated.graphChanges.find((change) => change.kind === "group-deleted" && change.groupIds.includes("group-hosted"))?.status).toBe("pending");
  });
});

async function enableHost(root: string, port: number) {
  const bundle = await ensureFixtureProject(root);
  const updated = await updateProjectSettings(root, {
    ...bundle.project.settings,
    externalMcpHost: {
      ...bundle.project.settings.externalMcpHost,
      enabled: true,
      port
    }
  });
  await syncExternalMcpHost(root, updated.project.settings);
  return updated;
}

async function connectRpc(endpoint: string, token: string): Promise<(method: string, params?: Record<string, unknown>) => Promise<Record<string, any>>> {
  let nextId = 1;
  let sessionId: string | undefined;
  const send = async (method: string, params?: Record<string, unknown>) => {
    const id = nextId++;
    const response = await postRpc(endpoint, token, { jsonrpc: "2.0", id, method, params }, sessionId);
    sessionId = response.sessionId ?? sessionId;
    return response.data;
  };
  await send("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "archicode-host-test", version: "0.1.0" }
  });
  await postRpc(endpoint, token, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  return send;
}

async function postRpc(
  endpoint: string,
  token: string,
  body: Record<string, unknown>,
  sessionId?: string
): Promise<{ data: Record<string, any>; sessionId?: string }> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      ...(sessionId ? { "mcp-session-id": sessionId } : {})
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`RPC ${body.method} failed with ${response.status}: ${text}`);
  const nextSessionId = response.headers.get("mcp-session-id") ?? undefined;
  if (response.status === 202 || !text.trim()) return { data: {}, sessionId: nextSessionId };
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = text.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice(6);
    if (!data) throw new Error(`Missing SSE data for ${body.method}: ${text}`);
    return { data: JSON.parse(data) as Record<string, any>, sessionId: nextSessionId };
  }
  return { data: JSON.parse(text) as Record<string, any>, sessionId: nextSessionId };
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  const port = await listenOnFreePort(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function listenOnFreePort(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
  return address.port;
}
