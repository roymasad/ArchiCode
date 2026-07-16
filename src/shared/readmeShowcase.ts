import { createSeedProject } from "./fixtures";
import {
  projectBundleSchema,
  researchChatSessionSchema,
  type ArchicodeNode,
  type Flow,
  type FlowEdge,
  type ProjectBundle,
  type ResearchChatSession
} from "./schema";

export type ReadmeShowcaseScenario = "overview" | "knowledge" | "chat";

export const readmeShowcaseTimestamp = "2026-07-12T09:30:00.000Z";

type ShowcaseNodeOptions = Partial<Pick<
  ArchicodeNode,
  "type" | "description" | "stage" | "flags" | "locked" | "position" | "subflowId" | "groupId" | "techStack" | "acceptanceCriteria" | "customProperties" | "visual"
>>;

function node(id: string, title: string, options: ShowcaseNodeOptions = {}): ArchicodeNode {
  return {
    id,
    type: options.type ?? "component",
    title,
    description: options.description ?? `${title} is part of the ArchiCode architecture workspace.`,
    stage: options.stage ?? "working",
    ignored: false,
    flags: options.flags ?? [],
    locked: options.locked ?? false,
    visual: options.visual ?? {},
    position: options.position ?? { x: 80, y: 80 },
    subflowId: options.subflowId,
    groupId: options.groupId,
    techStack: options.techStack ?? [],
    acceptanceCriteria: options.acceptanceCriteria ?? [],
    acceptanceChecks: [],
    customProperties: options.customProperties ?? {},
    attachments: [],
    todos: [],
    updatedAt: readmeShowcaseTimestamp
  };
}

function edge(
  id: string,
  source: string,
  target: string,
  label: string,
  path = "src/shared/schema.ts",
  origin: "extracted" | "resolved" | "inferred" | "user" = "extracted"
): FlowEdge {
  return {
    id,
    source,
    target,
    label,
    evidence: {
      origin,
      confidence: origin === "inferred" ? 0.78 : 0.98,
      relationKinds: [label],
      locations: [{ path, line: 24 }],
      analyzerVersion: 1,
      checkedAt: readmeShowcaseTimestamp,
      verification: origin === "inferred" ? "ambiguous" : "verified",
      freshness: "current"
    }
  };
}

function architectureFlow(): Flow {
  const rootNodes = [
    node("show-canvas", "Architecture Canvas", {
      type: "feature",
      description: "Editable architecture perspectives connect specs, source evidence, decisions, and implementation state.",
      position: { x: 70, y: 80 },
      groupId: "show-group-visual",
      flags: ["changed"],
      visual: { backgroundColor: "#225e6c" }
    }),
    node("show-3d", "Multi-Layer 3D Explorer", {
      type: "feature",
      description: "A read-only spatial view keeps root flows and nested detail flows visible as navigable layers.",
      position: { x: 390, y: 80 },
      groupId: "show-group-visual",
      stage: "draft-approved-production",
      locked: true,
      flags: ["user-approved"],
      visual: { backgroundColor: "#2d6877" }
    }),
    node("show-knowledge", "Code Knowledge Engine", {
      type: "component",
      description: "Deterministic scanning and source citations build a durable graph of modules, symbols, imports, calls, and runtime links.",
      position: { x: 70, y: 390 },
      groupId: "show-group-intelligence",
      flags: ["has-diff"],
      visual: { backgroundColor: "#51447d" }
    }),
    node("show-community", "Architecture Knowledge Map", {
      type: "feature",
      description: "Relationship communities reveal functional neighborhoods while every edge stays inspectable against source evidence.",
      position: { x: 390, y: 390 },
      groupId: "show-group-intelligence",
      stage: "draft-approved-production",
      locked: true,
      flags: ["user-approved"],
      visual: { backgroundColor: "#665494" }
    }),
    node("show-research", "Scoped Research Chat", {
      type: "feature",
      description: "Project, flow, subflow, and node conversations share the exact graph context and return reviewable proposals.",
      position: { x: 790, y: 80 },
      groupId: "show-group-agents",
      flags: ["changed"],
      visual: { backgroundColor: "#276456" }
    }),
    node("show-queue", "Agent Work Queue", {
      type: "component",
      description: "Planning, implementation, debugging, and verification progress through explicit gates with traceable artifacts.",
      position: { x: 1110, y: 80 },
      groupId: "show-group-agents",
      flags: ["modified-not-built"],
      visual: { backgroundColor: "#376b4c" }
    }),
    node("show-memory", "Local Project Memory", {
      type: "database",
      description: "Readable .archicode files keep diagrams, notes, runs, evidence, and decisions beside the codebase.",
      position: { x: 790, y: 390 },
      groupId: "show-group-foundation",
      stage: "draft-approved-production",
      locked: true,
      flags: ["user-approved"],
      visual: { backgroundColor: "#77542d", shape: "database" }
    }),
    node("show-quality", "Verification & Review", {
      type: "task",
      description: "Acceptance checks, source diffs, policy findings, and human approvals keep graph intent aligned with code.",
      position: { x: 1110, y: 390 },
      groupId: "show-group-foundation",
      flags: ["needs-attention"],
      visual: { backgroundColor: "#7b493d" }
    })
  ];

  const detailNodes = [
    node("canvas-perspectives", "Architecture Perspectives", { subflowId: "show-subflow-canvas", position: { x: 40, y: 40 }, type: "feature" }),
    node("canvas-editor", "Graph Editor", { subflowId: "show-subflow-canvas", position: { x: 350, y: 40 }, type: "component" }),
    node("canvas-groups", "Groups & Detail Flows", { subflowId: "show-subflow-canvas", position: { x: 40, y: 250 }, type: "feature" }),
    node("canvas-import", "Diagram Import & Export", { subflowId: "show-subflow-canvas", position: { x: 350, y: 250 }, type: "feature" }),

    node("knowledge-scanner", "Deterministic Scanner", { subflowId: "show-subflow-knowledge", position: { x: 40, y: 40 }, type: "component" }),
    node("knowledge-evidence", "Evidence Graph", { subflowId: "show-subflow-knowledge", position: { x: 350, y: 40 }, type: "database" }),
    node("knowledge-communities", "Community Detection", { subflowId: "show-subflow-knowledge", position: { x: 40, y: 250 }, type: "component" }),
    node("knowledge-semantic", "Semantic Search", { subflowId: "show-subflow-knowledge", position: { x: 350, y: 250 }, type: "feature" }),
    node("evidence-files", "Files", { subflowId: "show-subflow-evidence", position: { x: 40, y: 40 }, type: "artifact" }),
    node("evidence-symbols", "Symbols", { subflowId: "show-subflow-evidence", position: { x: 320, y: 40 }, type: "artifact" }),
    node("evidence-imports", "Imports & Calls", { subflowId: "show-subflow-evidence", position: { x: 40, y: 240 }, type: "artifact" }),
    node("evidence-runtime", "Runtime Links", { subflowId: "show-subflow-evidence", position: { x: 320, y: 240 }, type: "artifact" }),

    node("research-scope", "Scope Builder", { subflowId: "show-subflow-research", position: { x: 40, y: 40 }, type: "component" }),
    node("research-context", "Context Builder", { subflowId: "show-subflow-research", position: { x: 350, y: 40 }, type: "component" }),
    node("research-agents", "Specialist Subagents", { subflowId: "show-subflow-research", position: { x: 40, y: 250 }, type: "feature" }),
    node("research-review", "Graph Change Review", { subflowId: "show-subflow-research", position: { x: 350, y: 250 }, type: "task" }),
    node("memory-summary", "Rolling Summary", { subflowId: "show-subflow-chat-memory", position: { x: 40, y: 40 }, type: "artifact" }),
    node("memory-decisions", "Decisions & Todos", { subflowId: "show-subflow-chat-memory", position: { x: 320, y: 40 }, type: "artifact" }),
    node("memory-attachments", "Files & Images", { subflowId: "show-subflow-chat-memory", position: { x: 40, y: 240 }, type: "artifact" }),
    node("memory-usage", "Context & Usage", { subflowId: "show-subflow-chat-memory", position: { x: 320, y: 240 }, type: "setting" }),

    node("queue-plan", "Planning Gate", { subflowId: "show-subflow-queue", position: { x: 40, y: 40 }, type: "task" }),
    node("queue-source", "Source Handoff", { subflowId: "show-subflow-queue", position: { x: 350, y: 40 }, type: "component" }),
    node("queue-verify", "Verification Runner", { subflowId: "show-subflow-queue", position: { x: 40, y: 250 }, type: "task" }),
    node("queue-debug", "Debug Loop", { subflowId: "show-subflow-queue", position: { x: 350, y: 250 }, type: "task" }),

    node("storage-project", "Project JSON", { subflowId: "show-subflow-storage", position: { x: 40, y: 40 }, type: "artifact" }),
    node("storage-flows", "Flow Documents", { subflowId: "show-subflow-storage", position: { x: 350, y: 40 }, type: "artifact" }),
    node("storage-ledgers", "Append-Only Ledgers", { subflowId: "show-subflow-storage", position: { x: 40, y: 250 }, type: "database" }),
    node("storage-artifacts", "Run Artifacts", { subflowId: "show-subflow-storage", position: { x: 350, y: 250 }, type: "artifact" }),

    node("quality-criteria", "Acceptance Criteria", { subflowId: "show-subflow-quality", position: { x: 40, y: 40 }, type: "setting" }),
    node("quality-tests", "Executable Checks", { subflowId: "show-subflow-quality", position: { x: 350, y: 40 }, type: "task" }),
    node("quality-policy", "Architecture Policies", { subflowId: "show-subflow-quality", position: { x: 40, y: 250 }, type: "setting" }),
    node("quality-approval", "Human Approval", { subflowId: "show-subflow-quality", position: { x: 350, y: 250 }, type: "task" })
  ];

  const rootEdges = [
    edge("show-edge-canvas-3d", "show-canvas", "show-3d", "projects into", "src/renderer/src/components/FlowCanvas3DView.tsx"),
    edge("show-edge-knowledge-map", "show-knowledge", "show-community", "organizes", "src/renderer/src/components/CodeKnowledgeMapView.tsx"),
    edge("show-edge-knowledge-canvas", "show-knowledge", "show-canvas", "grounds", "src/main/importer/index.ts"),
    edge("show-edge-chat-canvas", "show-research", "show-canvas", "proposes changes", "src/renderer/src/components/ResearchPanel.tsx"),
    edge("show-edge-chat-queue", "show-research", "show-queue", "queues reviewed work", "src/main/research.ts"),
    edge("show-edge-memory-chat", "show-memory", "show-research", "restores context", "src/main/storage.ts"),
    edge("show-edge-queue-quality", "show-queue", "show-quality", "must verify", "src/main/orchestrator.ts"),
    edge("show-edge-quality-canvas", "show-quality", "show-canvas", "updates status", "src/shared/schema.ts"),
    edge("show-edge-memory-knowledge", "show-memory", "show-knowledge", "persists evidence", "src/main/codeKnowledge.ts")
  ];

  const detailEdges = [
    edge("canvas-e1", "canvas-perspectives", "canvas-editor", "renders"),
    edge("canvas-e2", "canvas-editor", "canvas-groups", "organizes"),
    edge("canvas-e3", "canvas-import", "canvas-perspectives", "hydrates"),
    edge("knowledge-e1", "knowledge-scanner", "knowledge-evidence", "extracts", "src/main/importer/scan.ts"),
    edge("knowledge-e2", "knowledge-evidence", "knowledge-communities", "clusters", "src/main/importer/organize.ts"),
    edge("knowledge-e3", "knowledge-evidence", "knowledge-semantic", "indexes", "src/main/semanticIndex.ts"),
    edge("evidence-e1", "evidence-files", "evidence-symbols", "contains"),
    edge("evidence-e2", "evidence-symbols", "evidence-imports", "resolves"),
    edge("evidence-e3", "evidence-imports", "evidence-runtime", "correlates", "src/main/codeKnowledge.ts"),
    edge("research-e1", "research-scope", "research-context", "selects"),
    edge("research-e2", "research-context", "research-agents", "delegates"),
    edge("research-e3", "research-agents", "research-review", "returns proposals"),
    edge("memory-e1", "memory-summary", "memory-decisions", "retains"),
    edge("memory-e2", "memory-attachments", "memory-summary", "informs"),
    edge("memory-e3", "memory-summary", "memory-usage", "compacts"),
    edge("queue-e1", "queue-plan", "queue-source", "unlocks"),
    edge("queue-e2", "queue-source", "queue-verify", "hands off"),
    edge("queue-e3", "queue-verify", "queue-debug", "on failure"),
    edge("storage-e1", "storage-project", "storage-flows", "references"),
    edge("storage-e2", "storage-flows", "storage-ledgers", "records changes"),
    edge("storage-e3", "storage-ledgers", "storage-artifacts", "links"),
    edge("quality-e1", "quality-criteria", "quality-tests", "becomes"),
    edge("quality-e2", "quality-tests", "quality-approval", "supports"),
    edge("quality-e3", "quality-policy", "quality-approval", "guards")
  ];

  return {
    id: "flow-showcase",
    name: "ArchiCode Architecture",
    description: "How visual architecture, code evidence, scoped research, agents, and verification work together.",
    ignored: false,
    visual: { icon: "layers", color: "#5b9cf6" },
    perspective: {
      kind: "modules-components",
      source: "user",
      generated: false,
      question: "How do ArchiCode's core capabilities cooperate?",
      confidence: "high",
      evidenceBasis: ["renderer components", "main-process services", "shared schemas"],
      limitations: [],
      checkedAt: readmeShowcaseTimestamp,
      coverage: { subjects: rootNodes.length + detailNodes.length, relations: rootEdges.length + detailEdges.length, observedRelations: rootEdges.length + detailEdges.length, inferredRelations: 0 }
    },
    groups: [
      { id: "show-group-visual", name: "Visual Architecture", color: "#3aa6bd" },
      { id: "show-group-intelligence", name: "Code Intelligence", color: "#9077cf" },
      { id: "show-group-agents", name: "Research & Agents", color: "#50a979" },
      { id: "show-group-foundation", name: "Trust & Persistence", color: "#c88951" }
    ],
    subflows: [
      { id: "show-subflow-canvas", name: "Visual Architecture", ignored: false, parentNodeId: "show-canvas" },
      { id: "show-subflow-knowledge", name: "Code Intelligence", ignored: false, parentNodeId: "show-knowledge" },
      { id: "show-subflow-evidence", name: "Source Evidence", ignored: false, parentNodeId: "knowledge-evidence", parentSubflowId: "show-subflow-knowledge" },
      { id: "show-subflow-research", name: "Research Workspace", ignored: false, parentNodeId: "show-research" },
      { id: "show-subflow-chat-memory", name: "Conversation Memory", ignored: false, parentNodeId: "research-context", parentSubflowId: "show-subflow-research" },
      { id: "show-subflow-queue", name: "Agent Runtime", ignored: false, parentNodeId: "show-queue" },
      { id: "show-subflow-storage", name: "Durable Project State", ignored: false, parentNodeId: "show-memory" },
      { id: "show-subflow-quality", name: "Verification System", ignored: false, parentNodeId: "show-quality" }
    ],
    nodes: [...rootNodes, ...detailNodes],
    edges: [...rootEdges, ...detailEdges],
    updatedAt: readmeShowcaseTimestamp
  };
}

const knowledgeCommunities = [
  {
    id: "workspace",
    color: "#3aa6bd",
    nodes: [
      ["workspace-shell", "Workspace Shell", "feature"],
      ["workspace-toolbar", "Project Toolbar", "component"],
      ["workspace-canvas", "Flow Canvas", "component"],
      ["workspace-inspector", "Node Inspector", "component"],
      ["workspace-activity", "Activity Panel", "component"]
    ]
  },
  {
    id: "intelligence",
    color: "#9077cf",
    nodes: [
      ["intel-importer", "Codebase Importer", "component"],
      ["intel-evidence", "Evidence Graph", "database"],
      ["intel-map", "Knowledge Map", "feature"],
      ["intel-semantic", "Semantic Index", "component"],
      ["intel-resync", "Delta Resync", "feature"]
    ]
  },
  {
    id: "research",
    color: "#50a979",
    nodes: [
      ["research-panel", "Research Panel", "feature"],
      ["research-context", "Context Builder", "component"],
      ["research-memory", "Conversation Memory", "database"],
      ["research-subagents", "Specialist Subagents", "component"],
      ["research-changes", "Graph Change Review", "task"]
    ]
  },
  {
    id: "runtime",
    color: "#e38a4d",
    nodes: [
      ["runtime-queue", "Agent Queue", "component"],
      ["runtime-providers", "Provider Adapters", "component"],
      ["runtime-tools", "MCP & Project Tools", "component"],
      ["runtime-source", "Source Handoff", "component"],
      ["runtime-debug", "Debug Runtime", "feature"]
    ]
  },
  {
    id: "persistence",
    color: "#d15f6f",
    nodes: [
      ["state-storage", "Project Storage", "database"],
      ["state-schema", "Durable Schema", "component"],
      ["state-notes", "Notes Ledger", "artifact"],
      ["state-runs", "Run Records", "artifact"],
      ["state-git", "Git Integration", "feature"]
    ]
  }
] as const;

function knowledgeFlow(): Flow {
  const nodes = knowledgeCommunities.flatMap((community, communityIndex) => community.nodes.map(([id, title, type], nodeIndex) => node(id, title, {
    type,
    description: `${title} belongs to the ${community.id} relationship community detected from code and runtime evidence.`,
    stage: nodeIndex === 0 ? "draft-approved-production" : "working",
    locked: nodeIndex === 0,
    flags: nodeIndex === 0 ? ["user-approved"] : nodeIndex === 3 ? ["has-diff"] : [],
    position: { x: 120 + (communityIndex % 3) * 440 + (nodeIndex % 2) * 190, y: 80 + Math.floor(communityIndex / 3) * 520 + Math.floor(nodeIndex / 2) * 150 },
    customProperties: {
      "Dependency community": community.id,
      "Community method": "relationship clustering",
      "Evidence status": "verified"
    },
    visual: { backgroundColor: community.color }
  })));

  const edges: FlowEdge[] = [];
  for (const community of knowledgeCommunities) {
    for (let index = 0; index < community.nodes.length - 1; index += 1) {
      const source = community.nodes[index][0];
      const target = community.nodes[index + 1][0];
      edges.push(edge(`knowledge-${community.id}-${index}`, source, target, index % 2 ? "calls" : "imports", `src/${community.id}/${source}.ts`));
    }
  }
  edges.push(
    edge("knowledge-cross-ui-intel", "workspace-canvas", "intel-map", "renders", "src/renderer/src/components/FlowCanvas.tsx"),
    edge("knowledge-cross-intel-research", "intel-evidence", "research-context", "grounds", "src/shared/contextBuilder.ts"),
    edge("knowledge-cross-research-runtime", "research-changes", "runtime-queue", "queues", "src/main/research.ts"),
    edge("knowledge-cross-runtime-state", "runtime-source", "state-runs", "records", "src/main/orchestrator.ts"),
    edge("knowledge-cross-state-intel", "state-storage", "intel-resync", "refreshes", "src/main/storage.ts"),
    edge("knowledge-cross-runtime-tools", "runtime-tools", "research-panel", "extends", "src/main/mcp.ts", "resolved"),
    edge("knowledge-cross-git-import", "state-git", "intel-importer", "detects changes", "src/main/git.ts", "inferred")
  );

  return {
    id: "flow-knowledge-showcase",
    name: "Architecture Knowledge Communities",
    description: "A relationship-derived view of functional code communities with inspectable source evidence.",
    ignored: false,
    visual: { icon: "network", color: "#9077cf" },
    perspective: {
      kind: "dependency-health",
      source: "codebase-importer",
      generated: true,
      question: "Which parts of the architecture change together, and why?",
      confidence: "high",
      evidenceBasis: ["imports", "calls", "runtime links", "source locations"],
      limitations: ["The README screenshot uses fixed community IDs so visual output is deterministic."],
      checkedAt: readmeShowcaseTimestamp,
      coverage: { subjects: nodes.length, relations: edges.length, observedRelations: edges.filter((item) => item.evidence?.origin !== "inferred").length, inferredRelations: edges.filter((item) => item.evidence?.origin === "inferred").length }
    },
    nodes,
    edges,
    subflows: [],
    groups: [],
    updatedAt: readmeShowcaseTimestamp
  };
}

export function createReadmeShowcaseBundle(
  rootPath = "/readme-showcase",
  scenario: ReadmeShowcaseScenario = "overview"
): ProjectBundle {
  const seed = createSeedProject(rootPath);
  const architecture = architectureFlow();
  const knowledge = knowledgeFlow();
  const activeFlowId = scenario === "knowledge" ? knowledge.id : architecture.id;
  return projectBundleSchema.parse({
    rootPath,
    project: {
      ...seed.project,
      id: "project-readme-showcase",
      name: "ArchiCode",
      description: "Visual architecture intelligence for codebases, humans, and coding agents.",
      activeFlowId,
      createdAt: readmeShowcaseTimestamp,
      updatedAt: readmeShowcaseTimestamp
    },
    flows: [architecture, knowledge],
    notes: [],
    incidents: [],
    runs: [],
    artifacts: [],
    summaries: [],
    graphChanges: [],
    validationErrors: []
  });
}

export function createReadmeShowcaseResearchSessions(rootPath = "/readme-showcase"): ResearchChatSession[] {
  return [researchChatSessionSchema.parse({
    id: "showcase-research-session",
    projectRoot: rootPath,
    scope: { type: "flow", flowId: "flow-showcase" },
    title: "Connect code evidence to architecture decisions",
    summary: "Use source-backed communities to guide architecture exploration and reviewed implementation work.",
    memory: {
      summary: "The architecture map stays grounded in code evidence; proposed graph changes require review before implementation.",
      decisions: [{
        id: "showcase-decision",
        text: "Keep community maps evidence-backed and make every suggested architecture change reviewable.",
        sourceMessageIds: ["showcase-assistant"],
        createdAt: readmeShowcaseTimestamp
      }],
      todos: [{
        id: "showcase-todo",
        title: "Review the proposed architecture tour",
        status: "awaiting-approval",
        sourceMessageIds: ["showcase-assistant"],
        createdAt: readmeShowcaseTimestamp
      }],
      graphRefs: [{
        id: "showcase-graph-ref",
        kind: "node",
        flowId: "flow-showcase",
        nodeId: "show-community",
        title: "Architecture Knowledge Map",
        note: "Primary evidence-navigation entry point.",
        sourceMessageIds: ["showcase-assistant"],
        createdAt: readmeShowcaseTimestamp
      }],
      updatedAt: readmeShowcaseTimestamp
    },
    orchestration: {
      todos: [{
        id: "showcase-orchestration",
        title: "Apply the reviewed architecture tour",
        status: "awaiting-approval",
        changeSetId: "showcase-change-set",
        messageId: "showcase-assistant",
        operationIndexes: [0, 1, 2],
        createdAt: readmeShowcaseTimestamp
      }],
      updatedAt: readmeShowcaseTimestamp
    },
    autoApproveGraphChanges: { enabled: false, includeDestructive: false },
    archived: false,
    messages: [
      {
        id: "showcase-user",
        role: "user",
        content: "How should the code knowledge map, 3D architecture view, and implementation agents work together without losing source truth?",
        createdAt: readmeShowcaseTimestamp
      },
      {
        id: "showcase-assistant",
        role: "assistant",
        content: "Treat them as one evidence-to-action loop:\n\n1. **Explore** relationship communities in the knowledge map.\n2. **Understand** boundaries across nested architecture layers in 3D.\n3. **Decide** in this scoped chat with the relevant nodes and source citations attached.\n4. **Act** only after reviewing the proposed graph changes and queued verification work.\n\nI prepared a small, non-destructive architecture update for review.",
        createdAt: readmeShowcaseTimestamp,
        webUsed: false,
        mcpToolCalls: [
          {
            serverId: "archicode-tools",
            serverLabel: "ArchiCode Tools",
            toolName: "search_files",
            argumentsJson: "{\"query\":\"Dependency community\",\"path\":\"src\"}",
            status: "succeeded",
            resultSummary: "Found source-backed community metadata and knowledge-map rendering paths.",
            createdAt: readmeShowcaseTimestamp
          },
          {
            serverId: "archicode-tools",
            serverLabel: "ArchiCode Tools",
            toolName: "read_context",
            argumentsJson: "{\"scope\":\"flow-showcase\"}",
            status: "succeeded",
            resultSummary: "Loaded the scoped architecture graph and linked evidence.",
            createdAt: readmeShowcaseTimestamp
          }
        ],
        changeSet: {
          id: "showcase-change-set",
          summary: "Make the evidence-to-action workflow explicit in the architecture map.",
          operations: [
            {
              kind: "update-node",
              flowId: "flow-showcase",
              patch: {
                id: "show-community",
                description: "Relationship communities reveal functional neighborhoods while every edge stays inspectable against source evidence."
              }
            },
            {
              kind: "update-edge",
              flowId: "flow-showcase",
              edgeId: "show-edge-chat-queue",
              patch: { label: "queues reviewed work" }
            },
            {
              kind: "add-note",
              note: {
                flowId: "flow-showcase",
                nodeId: "show-quality",
                kind: "user-note",
                author: "llm",
                body: "Keep source citations and acceptance checks visible at the review gate.",
                category: "decision",
                priority: "high",
                attachmentIds: [],
                resolved: false,
                pinned: true
              }
            }
          ],
          createdAt: readmeShowcaseTimestamp
        },
        usage: {
          providerId: "openai-compatible",
          modelId: "gpt-5.5",
          inputTokens: 8420,
          outputTokens: 612,
          thinkingTokens: 980,
          cacheReadTokens: 3100,
          calls: 3,
          costUsd: 0.041,
          contextMode: "compact"
        }
      }
    ],
    providerId: "openai-compatible",
    modelId: "gpt-5.5",
    webEnabled: true,
    createdAt: readmeShowcaseTimestamp,
    updatedAt: readmeShowcaseTimestamp
  })];
}
