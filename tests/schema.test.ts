import { describe, expect, it } from "vitest";
import { applyNodePatch, codeIdeSettingsSchema, defaultCodexRealtimeModel, flowSchema, llmPatchProposalSchema, projectSchema, researchCanvasActionSchema, researchChatSessionSchema, researchGraphChangeSetSchema, runGuidanceSchema, runImplementationTaskSchema, runSchema, voiceSettingsSchema, type ArchicodeNode } from "../src/shared/schema";
import flowFixture from "../fixtures/sample-project/.archicode/flows/flow-main.json";
import projectFixture from "../fixtures/sample-project/.archicode/project.json";

describe("ArchiCode JSON schemas", () => {
  it("does not assume a default code application and stores a picked application", () => {
    expect(codeIdeSettingsSchema.parse(undefined)).toEqual({ applicationName: "", applicationPath: "" });
    expect(codeIdeSettingsSchema.parse({ applicationName: "My Editor", applicationPath: "/Applications/My Editor.app" })).toEqual({
      applicationName: "My Editor",
      applicationPath: "/Applications/My Editor.app"
    });
  });

  it("defaults voice mode to local and migrates the legacy Codex realtime mode", () => {
    expect(voiceSettingsSchema.parse(undefined)).toEqual({
      mode: "local",
      codexRealtime: {
        voice: "marin",
        outputModality: "audio",
        model: defaultCodexRealtimeModel,
        includeStartupContext: true
      }
    });
    expect(voiceSettingsSchema.parse({
      mode: "off",
      codexRealtime: undefined
    }).mode).toBe("local");
    expect(voiceSettingsSchema.parse({
      mode: "codex-realtime",
      codexRealtime: {
        model: null,
        voice: "juniper"
      }
    })).toMatchObject({ mode: "openai-realtime", codexRealtime: { model: defaultCodexRealtimeModel } });
    expect(voiceSettingsSchema.parse({
      mode: "codex-realtime",
      codexRealtime: {
        voice: "cove",
        outputModality: "audio",
        model: "gpt-realtime",
        includeStartupContext: false
      }
    }).codexRealtime.voice).toBe("cove");
  });

  it("validates reversible research canvas actions", () => {
    expect(researchCanvasActionSchema.parse({
      flowId: "flow-main",
      nodeIds: ["node-a", "node-b"],
      groupIds: ["group-api"],
      viewport: { mode: "fit" }
    })).toMatchObject({
      selection: "replace",
      viewport: { mode: "fit", padding: 0.24, maxZoom: 1.08 }
    });
    expect(researchCanvasActionSchema.parse({
      flowId: "flow-main",
      selection: "preserve",
      viewport: { mode: "pan", dx: 240, dy: -80 }
    }).viewport).toEqual({ mode: "pan", dx: 240, dy: -80 });
    expect(researchCanvasActionSchema.safeParse({
      flowId: "flow-main",
      viewport: { mode: "zoom-to", zoom: 9 }
    }).success).toBe(false);
  });

  it("validates the sample project and flow fixtures", () => {
    expect(projectSchema.parse(projectFixture).name).toBe("ArchiCode");
    expect(flowSchema.parse(flowFixture).nodes.length).toBeGreaterThan(0);
  });

  it("loads projects with legacy MCP caps without preserving those caps", () => {
    const parsed = projectSchema.parse({
      ...projectFixture,
      settings: {
        ...projectFixture.settings,
        mcp: {
          servers: [],
          maxToolIterations: 8,
          maxToolResultChars: 12000
        }
      }
    });

    expect(parsed.settings.mcp).toEqual({ servers: [] });
  });

  it("defaults new project settings to a neutral gray canvas background", () => {
    const parsed = projectSchema.parse({
      ...projectFixture,
      settings: {
        ...projectFixture.settings,
        canvasBackground: undefined,
        canvasEdgeStyle: undefined,
        researchAutoApproveGraphChanges: undefined
      }
    });

    expect(parsed.settings.canvasBackground).toBe("neutral-gray");
    expect(parsed.settings.canvasEdgeStyle).toBe("current");
    expect(parsed.settings.inspectorUtilityTabsExpanded).toBe(false);
    expect(parsed.settings.inspectorNodeAppearanceExpanded).toBe(false);
    expect(parsed.settings.activityArtifactTabsExpanded).toBe(false);
    expect(parsed.settings.customNodeTypes).toEqual([]);
    expect(parsed.settings.customNodeProperties).toEqual([]);
    expect(parsed.settings.researchAutoApproveGraphChanges).toEqual({ enabled: false, includeDestructive: false });
    expect(parsed.settings.purgeResolvedNotesOnApproval).toBe(false);
    expect(parsed.settings.notifications.reviewRequired).toBe(true);
    expect(parsed.settings.externalMcpHost).toEqual({
      enabled: false,
      host: "127.0.0.1",
      port: 37373,
      requireToken: true,
      writeMode: "apply"
    });
    expect(parsed.settings.providers.every((provider) => provider.detectedModelCapabilities && typeof provider.detectedModelCapabilities === "object")).toBe(true);
  });

  it("persists provider output verbosity while keeping model default implicit", () => {
    const parsed = projectSchema.parse({
      ...projectFixture,
      settings: {
        ...projectFixture.settings,
        providers: projectFixture.settings.providers.map((provider, index) => index === 0
          ? { ...provider, outputVerbosity: "high" }
          : provider)
      }
    });

    expect(parsed.settings.providers[0]?.outputVerbosity).toBe("high");
    expect(parsed.settings.providers[1]?.outputVerbosity).toBeUndefined();
  });

  it("defaults Sherlock and Delphi on without re-enabling a legacy-disabled Picasso setting", () => {
    const parsed = projectSchema.parse({
      ...projectFixture,
      settings: {
        ...projectFixture.settings,
        agentTools: {
          projectFiles: true,
          runArtifacts: true,
          console: true,
          subagents: {
            mergeConflictResolution: true,
            graphReconciliation: false
          }
        }
      }
    });

    expect(parsed.settings.agentTools.subagents?.sherlockResearch).toBe(true);
    expect(parsed.settings.agentTools.subagents?.delphiTesting).toBe(true);
    expect(parsed.settings.agentTools.subagents?.graphReconciliation).toBe(false);
  });

  it("allows custom node types", () => {
    const baseFlow = flowSchema.parse(flowFixture);
    const flow = flowSchema.parse({
      ...baseFlow,
      nodes: [
        {
          ...baseFlow.nodes[0],
          id: "node-custom-type",
          type: "business-rule"
        }
      ],
      edges: []
    });

    expect(flow.nodes[0]?.type).toBe("business-rule");
  });

  it("persists reusable custom node text properties", () => {
    const project = projectSchema.parse({
      ...projectFixture,
      settings: {
        ...projectFixture.settings,
        customNodeProperties: [
          { id: "custom-owner", label: "Owner", type: "text" },
          { id: "custom-accent", label: "Accent", type: "color" }
        ]
      }
    });
    const legacyProject = projectSchema.parse({
      ...projectFixture,
      settings: {
        ...projectFixture.settings,
        customNodeProperties: [{ id: "custom-legacy", label: "Legacy" }]
      }
    });
    const baseFlow = flowSchema.parse(flowFixture);
    const flow = flowSchema.parse({
      ...baseFlow,
      nodes: [
        {
          ...baseFlow.nodes[0],
          customProperties: {
            "custom-owner": "Design systems",
            "custom-accent": "#7bc6d5"
          }
        }
      ],
      edges: []
    });

    expect(project.settings.customNodeProperties[0]?.label).toBe("Owner");
    expect(project.settings.customNodeProperties[0]?.type).toBe("text");
    expect(project.settings.customNodeProperties[1]?.type).toBe("color");
    expect(legacyProject.settings.customNodeProperties[0]?.type).toBe("text");
    expect(flow.nodes[0]?.customProperties["custom-owner"]).toBe("Design systems");
    expect(flow.nodes[0]?.customProperties["custom-accent"]).toBe("#7bc6d5");
  });

  it("persists reusable custom node type history", () => {
    const project = projectSchema.parse({
      ...projectFixture,
      settings: {
        ...projectFixture.settings,
        customNodeTypes: ["business-rule", "integration-point"]
      }
    });

    expect(project.settings.customNodeTypes).toEqual(["business-rule", "integration-point"]);
  });

  it("defaults nodes and flows to included in the agent working set", () => {
    const parsed = flowSchema.parse(flowFixture);

    expect(parsed.ignored).toBe(false);
    expect(parsed.nodes.every((node) => node.ignored === false)).toBe(true);
    expect(parsed.subflows.every((subflow) => subflow.ignored === false)).toBe(true);
    expect(parsed.groups).toEqual([]);
  });

  it("persists validated visual group colors", () => {
    const baseFlow = flowSchema.parse(flowFixture);
    const flow = flowSchema.parse({
      ...baseFlow,
      groups: [{ id: "group-ui", name: "UI Group", color: "#7bc6d5" }]
    });

    expect(flow.groups[0]?.color).toBe("#7bc6d5");
    expect(() => flowSchema.parse({
      ...baseFlow,
      groups: [{ id: "group-invalid", name: "Invalid Group", color: "blue" }]
    })).toThrow(/6-digit hex color/);
  });

  it("persists optional flow icons and colors", () => {
    const baseFlow = flowSchema.parse(flowFixture);
    const flow = flowSchema.parse({
      ...baseFlow,
      visual: { icon: "workflow", color: "#7bc6d5" }
    });

    expect(flow.visual).toEqual({ icon: "workflow", color: "#7bc6d5" });
    expect(flowSchema.parse({ ...baseFlow, visual: undefined }).visual).toBeUndefined();
    expect(() => flowSchema.parse({ ...baseFlow, visual: { icon: "rocket" } })).toThrow();
    expect(() => flowSchema.parse({ ...baseFlow, visual: { color: "teal" } })).toThrow(/6-digit hex color/);
  });

  it("locks nodes approved for production", () => {
    const node = flowSchema.parse(flowFixture).nodes.find((item) => item.id === "node-json-model") as ArchicodeNode;
    const approved = applyNodePatch(node, { id: node.id, stage: "draft-approved-production" }, "user");

    expect(approved.locked).toBe(true);
    expect(approved.flags).toContain("user-approved");
    expect(approved.flags).not.toContain("changed");
  });

  it("rejects LLM edits against approved nodes", () => {
    const node = flowSchema.parse(flowFixture).nodes.find((item) => item.id === "node-approved-contract") as ArchicodeNode;

    expect(() => applyNodePatch(node, { id: node.id, description: "Mutated by LLM" }, "llm")).toThrow(/approved and locked/);
  });

  it("rejects LLM attempts to approve nodes", () => {
    const node = flowSchema.parse(flowFixture).nodes.find((item) => item.id === "node-canvas") as ArchicodeNode;

    expect(() => applyNodePatch(node, { id: node.id, stage: "draft-approved-production" }, "llm")).toThrow(/cannot approve nodes/);
    expect(() => applyNodePatch(node, { id: node.id, stage: "plan-approved" }, "llm")).toThrow(/cannot approve nodes/);
    expect(() => applyNodePatch(node, { id: node.id, flags: ["changed", "user-approved"] }, "llm")).toThrow(/user-approved/);
    expect(() => applyNodePatch(node, { id: node.id, locked: true }, "llm")).toThrow(/lock nodes as approved/);
  });

  it("allows only users to change ignored node state", () => {
    const node = flowSchema.parse(flowFixture).nodes.find((item) => item.id === "node-canvas") as ArchicodeNode;
    const ignored = applyNodePatch(node, { id: node.id, ignored: true }, "user");

    expect(ignored.ignored).toBe(true);
    expect(ignored.flags).not.toContain("changed");
    expect(() => applyNodePatch(node, { id: node.id, ignored: true }, "llm")).toThrow(/cannot change whether nodes are ignored/);
    expect(() => applyNodePatch(ignored, { id: node.id, description: "Mutated by LLM" }, "llm")).toThrow(/ignored and outside/);
  });

  it("allows explicit user revision of approved nodes", () => {
    const node = flowSchema.parse(flowFixture).nodes.find((item) => item.id === "node-approved-contract") as ArchicodeNode;
    const revised = applyNodePatch(
      node,
      {
        id: node.id,
        stage: "draft",
        locked: false,
        flags: [],
        forceUnlockRevision: true
      },
      "user"
    );

    expect(revised.locked).toBe(false);
    expect(revised.stage).toBe("draft");
    expect(revised.flags).toContain("changed");
  });

  it("marks meaningful user edits as changed but ignores visual-only edits", () => {
    const node = {
      ...(flowSchema.parse(flowFixture).nodes.find((item) => item.id === "node-project") as ArchicodeNode),
      flags: []
    };
    const visual = applyNodePatch(node, { id: node.id, visual: { backgroundColor: "#7bc6d5" } }, "user");
    const grouped = applyNodePatch(node, { id: node.id, groupId: "group-ui" }, "user");
    const meaningful = applyNodePatch(node, { id: node.id, description: "Updated user intent." }, "user");
    const llmFlags = applyNodePatch(node, { id: node.id, flags: ["changed", "needs-attention"] }, "llm");

    expect(visual.flags).not.toContain("changed");
    expect(grouped.groupId).toBe("group-ui");
    expect(grouped.flags).not.toContain("changed");
    expect(meaningful.flags).toContain("changed");
    expect(llmFlags.flags).not.toContain("changed");
    expect(llmFlags.flags).toContain("needs-attention");
  });

  it("persists validated node visual styling", () => {
    const node = flowSchema.parse(flowFixture).nodes.find((item) => item.id === "node-project") as ArchicodeNode;
    const styled = applyNodePatch(
      node,
      {
        id: node.id,
        visual: {
          backgroundColor: "#1a2b3c",
          shape: "document"
        }
      },
      "user"
    );

    expect(styled.visual.backgroundColor).toBe("#1a2b3c");
    expect(styled.visual.shape).toBe("document");
    expect(() => applyNodePatch(node, { id: node.id, visual: { backgroundColor: "blue" } }, "user")).toThrow(/6-digit hex color/);
    expect(() => applyNodePatch(node, { id: node.id, visual: { shape: "triangle" as never } }, "user")).toThrow();
  });

  it("validates machine-readable LLM patch proposals", () => {
    const proposal = llmPatchProposalSchema.parse({
      schemaVersion: 1,
      runId: "run-123",
      summary: "Ask for missing provider details.",
      operations: [
        {
          kind: "add-note",
          note: {
            flowId: "flow-main",
            nodeId: "node-orchestrator",
            kind: "llm-question",
            author: "llm",
            body: "Which provider should execute this node?",
            resolved: false
          }
        },
        {
          kind: "propose-node",
          flowId: "flow-main",
          node: {
            id: "node-provider-health",
            type: "task",
            title: "Provider Health",
            summary: "Track provider readiness before running agent work."
          }
        },
        {
          kind: "propose-edge",
          flowId: "flow-main",
          edge: {
            source: "node-orchestrator",
            target: "node-provider-health",
            label: "checks"
          }
        },
        {
          kind: "propose-project-file",
          path: "AGENTS.md",
          content: "# Agent Instructions\n\nRun tests before finishing.",
          reason: "Missing durable local agent instructions."
        },
        {
          kind: "propose-source-file",
          path: "src/app.ts",
          action: "create",
          content: "export const app = true;\n",
          nodeId: "node-orchestrator",
          reason: "Create the first implementation file.",
          testIntent: "Covered by the generated app smoke test."
        }
      ]
    });

    expect(proposal.operations[0]?.kind).toBe("add-note");
    expect(proposal.operations[1]?.kind).toBe("propose-node");
    expect(proposal.operations[3]?.kind).toBe("propose-project-file");
    expect(proposal.operations[4]?.kind).toBe("propose-source-file");
  });

  it("normalizes legacy implementation effort and accepts task budgets", () => {
    const legacyRun = runSchema.parse({
      id: "run-legacy",
      flowId: "flow-main",
      providerId: "codex-local",
      status: "queued",
      effort: "normal",
      promptSummary: "Legacy effort",
      permission: { decision: "allowed" },
      createdAt: "2026-07-02T12:00:00.000Z"
    });
    expect(legacyRun.effort).toBe("high");

    const task = runImplementationTaskSchema.parse({
      id: "task-1",
      title: "Scaffold app",
      batchBudget: 6,
      lightVerificationCommand: "npm run typecheck",
      verificationCommand: "npm run build"
    });
    expect(task.batchBudget).toBe(6);
    expect(task.lightVerificationCommand).toBe("npm run typecheck");
  });

  it("validates research chat sessions and graph change sets", () => {
    const changeSet = researchGraphChangeSetSchema.parse({
      id: "changes-1",
      summary: "Expand auth planning.",
      createdAt: "2026-06-24T10:00:00.000Z",
      operations: [
        {
          kind: "create-node",
          flowId: "flow-main",
          node: {
            title: "OAuth Callback",
            summary: "Handle provider callback state and token exchange."
          }
        },
        {
          kind: "add-note",
          note: {
            flowId: "flow-main",
            nodeId: "node-project",
            kind: "user-note",
            author: "llm",
            body: "Research suggests confirming provider callback constraints.",
            resolved: false
          }
        }
      ]
    });
    const session = researchChatSessionSchema.parse({
      id: "research-1",
      projectRoot: "/tmp/project",
      scope: { type: "node", flowId: "flow-main", nodeId: "node-project" },
      title: "Auth research",
      messages: [
        {
          id: "msg-1",
          role: "assistant",
          content: "Here is the research.",
          webUsed: true,
          changeSet,
          createdAt: "2026-06-24T10:01:00.000Z"
        }
      ],
      createdAt: "2026-06-24T10:00:00.000Z",
      updatedAt: "2026-06-24T10:01:00.000Z"
    });

    expect(session.scope.type).toBe("node");
    expect(session.messages[0]?.changeSet?.operations).toHaveLength(2);
    expect(session.memory.summary).toBe("");
    expect(session.memory.todos).toEqual([]);
  });

  it("normalizes blank optional graph relationship ids from provider JSON", () => {
    const changeSet = researchGraphChangeSetSchema.parse({
      id: "changes-blank-refs",
      summary: "Create a root node",
      createdAt: "2026-07-10T17:01:19.116Z",
      operations: [{
        kind: "create-node",
        flowId: "flow-main",
        node: {
          id: "node-contact",
          title: "Contact",
          parentId: " ",
          subflowId: "",
          groupId: "",
          moduleProfileId: ""
        }
      }]
    });
    const operation = changeSet.operations[0];

    expect(operation?.kind).toBe("create-node");
    if (operation?.kind === "create-node") {
      expect(operation.node.parentId).toBeUndefined();
      expect(operation.node.subflowId).toBeUndefined();
      expect(operation.node.groupId).toBeUndefined();
      expect(operation.node.moduleProfileId).toBeUndefined();
    }
  });

  it("preserves structured research chat memory", () => {
    const session = researchChatSessionSchema.parse({
      id: "research-memory",
      projectRoot: "/tmp/project",
      scope: { type: "project", projectId: "project-seed" },
      title: "Memory chat",
      memory: {
        summary: "Long-running onboarding research.",
        decisions: [{
          id: "decision-auth",
          text: "Use passwordless auth first.",
          sourceMessageIds: ["msg-1"],
          createdAt: "2026-06-24T10:00:00.000Z"
        }],
        todos: [{
          id: "todo-copy",
          title: "Review onboarding copy",
          status: "open",
          sourceMessageIds: ["msg-2"],
          createdAt: "2026-06-24T10:01:00.000Z"
        }],
        openQuestions: [],
        links: [{
          id: "link-docs",
          url: "https://example.com/docs",
          title: "Docs",
          sourceMessageIds: ["msg-3"],
          createdAt: "2026-06-24T10:02:00.000Z"
        }],
        facts: [],
        assumptions: [],
        graphRefs: [],
        runRefs: [],
        debugFindings: [],
        updatedAt: "2026-06-24T10:03:00.000Z"
      },
      messages: [],
      createdAt: "2026-06-24T10:00:00.000Z",
      updatedAt: "2026-06-24T10:03:00.000Z"
    });

    expect(session.memory.summary).toContain("onboarding");
    expect(session.memory.decisions[0]?.sourceMessageIds).toEqual(["msg-1"]);
    expect(session.memory.todos[0]?.status).toBe("open");
    expect(session.memory.links[0]?.url).toBe("https://example.com/docs");
  });

  it("supports debugging as a durable run phase", () => {
    const run = runSchema.parse({
      id: "run-debug",
      flowId: "flow-main",
      providerId: "openai-compatible",
      status: "debugging",
      phase: "debugging",
      promptSummary: "Debug a failed verification",
      permission: { decision: "allowed" },
      createdAt: "2026-06-16T00:00:00.000Z"
    });

    expect(run.phase).toBe("debugging");
    expect(run.status).toBe("debugging");
  });

  it("defaults run guidance to user-authored while preserving research-agent source", () => {
    expect(runGuidanceSchema.parse({ text: "Focus the retry." }).source).toBe("user");
    expect(runGuidanceSchema.parse({ text: "Focus the retry.", source: "research-agent" }).source).toBe("research-agent");
  });
});
