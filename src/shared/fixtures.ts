import { defaultPhaseModelPolicies, defaultSubagentModelPolicies, type Flow, type Project } from "./schema";

const now = new Date().toISOString();

export function createSeedProject(rootPath: string): { project: Project; flow: Flow } {
  const project: Project = {
    schemaVersion: 1,
    id: "project-archicode",
    name: "ArchiCode",
    description: "A visual-first local harness for designing and evolving applications with LLM-guided node flows.",
    rootPath,
    activeFlowId: "flow-main",
    settings: {
      autoFocusSelectedNode: false,
      inspectorUtilityTabsExpanded: false,
      inspectorNodeAppearanceExpanded: false,
      activityArtifactTabsExpanded: false,
      canvasBackground: "neutral-gray",
      canvasEdgeStyle: "current",
      edgeLabelHistory: [],
      customNodeTypes: [],
      customNodeProperties: [],
      notifications: {
        jobFinished: true,
        reviewRequired: true
      },
      contextBudgetMode: "auto",
      patchReviewMode: "auto",
      planningReviewMode: "auto",
      codeReviewMode: "auto-apply",
      autoApproveShellCommands: true,
      researchAutoApproveGraphChanges: {
        enabled: false,
        includeDestructive: false
      },
      stopOnUnansweredQuestions: true,
      purgeResolvedNotesOnApproval: false,
      graphChangeRetention: "1month",
      contextTokenBudget: 120000,
      compactionThreshold: 90000,
      contextBuilder: {
        includeNotes: true,
        includeArtifacts: true,
        includeRuns: true,
        includeSummaries: true,
        includeLockedNodes: true,
        recentRunLimit: 8,
        artifactLimit: 20
      },
      semanticIndex: {
        enabled: true,
        maxRelatedNodes: 6
      },
      filesystem: {
        policy: "project-write",
        allowedRoots: [],
        blockOutsideProjectPaths: true
      },
      agentTools: {
        projectFiles: true,
        runArtifacts: true,
        console: true
      },
      webSearch: {
        provider: "native",
        enabled: true,
        requirePerRunApproval: true,
        persistSearchArtifacts: true
      },
      skills: {
        enabledSkillIds: []
      },
      mcp: {
        servers: []
      },
      externalMcpHost: {
        enabled: false,
        host: "127.0.0.1",
        port: 37373,
        requireToken: true,
        writeMode: "apply"
      },
      defaultBuildCommand: "",
      defaultRunCommand: "",
      buildTargetsLocked: false,
      runTargetProfiles: [],
      environmentNotes: "Local Electron app. Provider keys are saved as machine-local settings and scrubbed from project JSON.",
      stackAssumptions: ["Electron", "React", "TypeScript", "React Flow", "folder-based JSON"],
      allowedShellCommands: [],
      shellPolicies: [],
      providers: [
        {
          id: "openai-compatible",
          kind: "openai-compatible",
          label: "Custom OpenAI-Compatible",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-5.5",
          detectedAvailableModels: [],
          detectedModelCapabilities: {},
          localSandbox: "read-only",
          ephemeral: true,
          phaseModelPolicies: defaultPhaseModelPolicies,
          subagentModelPolicies: defaultSubagentModelPolicies,
          enabled: true
        },
        {
          id: "codex-local",
          kind: "codex-local",
          label: "Codex Local CLI",
          localCommand: "codex",
          detectedAvailableModels: [],
          detectedModelCapabilities: {},
          localSandbox: "workspace-write",
          ephemeral: true,
          model: "",
          phaseModelPolicies: defaultPhaseModelPolicies,
          subagentModelPolicies: defaultSubagentModelPolicies,
          enabled: false
        },
        {
          id: "anthropic-compatible",
          kind: "anthropic-compatible",
          label: "Anthropic Compatible",
          model: "claude-sonnet-4-6",
          detectedAvailableModels: [],
          detectedModelCapabilities: {},
          localSandbox: "read-only",
          ephemeral: true,
          phaseModelPolicies: defaultPhaseModelPolicies,
          subagentModelPolicies: defaultSubagentModelPolicies,
          enabled: false
        },
        {
          id: "claude-local",
          kind: "claude-local",
          label: "Claude Code CLI",
          localCommand: "claude",
          detectedAvailableModels: [],
          detectedModelCapabilities: {},
          localSandbox: "workspace-write",
          ephemeral: true,
          model: "",
          phaseModelPolicies: defaultPhaseModelPolicies,
          subagentModelPolicies: defaultSubagentModelPolicies,
          enabled: false
        }
      ],
      tools: []
    },
    createdAt: now,
    updatedAt: now
  };

  const flow: Flow = {
    id: "flow-main",
    name: "ArchiCode MVP Harness",
    description: "Top-level flow for the runnable agent harness.",
    ignored: false,
    subflows: [
      { id: "subflow-orchestrator", name: "Local Orchestrator", ignored: false, parentNodeId: "node-orchestrator" },
      { id: "subflow-json", name: "JSON Project Model", ignored: false, parentNodeId: "node-json-model" }
    ],
    groups: [],
    nodes: [
      {
        id: "node-project",
        type: "project",
        title: "Project Workspace",
        description: "Folder-based workspace storing all durable project state under .archicode.",
        stage: "plan-approved",
        ignored: false,
        flags: ["changed"],
        locked: false,
        visual: {},
        position: { x: 40, y: 80 },
        customProperties: {},
        techStack: ["JSON", "Electron IPC"],
        acceptanceCriteria: ["Project reloads from readable JSON", "Validation errors are visible"],
        acceptanceChecks: [],
        attachments: [],
        todos: [{ id: "todo-project-import-export", text: "Support import/export and validation", done: false }],
        updatedAt: now
      },
      {
        id: "node-json-model",
        type: "setting",
        title: "LLM-Clarifying JSON Model",
        description: "Projects, flows, nodes, notes, runs, artifacts, summaries, and settings stay as explicit JSON files.",
        stage: "plan-approved",
        ignored: false,
        flags: ["changed"],
        locked: false,
        visual: {},
        position: { x: 360, y: 30 },
        customProperties: {},
        techStack: ["Zod", "TypeScript"],
        acceptanceCriteria: ["Schemas cover stages and flags", "Locked approved nodes reject LLM edits"],
        acceptanceChecks: [],
        attachments: [],
        todos: [],
        updatedAt: now
      },
      {
        id: "node-canvas",
        type: "feature",
        title: "React Flow Canvas",
        description: "Visual-first interface for nodes, edges, subflows, status badges, diffs, notes, and approvals.",
        stage: "working",
        ignored: false,
        flags: ["modified-not-built"],
        locked: false,
        visual: {},
        position: { x: 680, y: 130 },
        customProperties: {},
        techStack: ["React", "React Flow", "Zustand"],
        acceptanceCriteria: ["Node status is scannable", "Inspector edits persist to JSON"],
        acceptanceChecks: [],
        attachments: [],
        todos: [],
        updatedAt: now
      },
      {
        id: "node-orchestrator",
        type: "component",
        title: "Local Agent Orchestrator",
        description: "Electron main process manages providers, context compaction, shell permissions, runs, and artifacts.",
        stage: "working",
        ignored: false,
        flags: ["needs-attention", "llm-question"],
        locked: false,
        visual: {},
        position: { x: 360, y: 300 },
        customProperties: {},
        techStack: ["Electron main", "child_process", "provider adapters"],
        acceptanceCriteria: ["Shell commands require explicit approval", "Runs persist logs and instructions"],
        acceptanceChecks: [],
        attachments: [],
        todos: [{ id: "todo-provider-api", text: "Wire direct provider calls after API key settings are confirmed", done: false }],
        updatedAt: now
      },
      {
        id: "node-approved-contract",
        type: "task",
        title: "Approved Node Contract",
        description: "Once a node reaches production approval, LLM runs can read it but must create a revision before changing it.",
        stage: "draft-approved-production",
        ignored: false,
        flags: ["user-approved"],
        locked: true,
        visual: {},
        position: { x: 40, y: 360 },
        customProperties: {},
        techStack: ["Zod", "policy"],
        acceptanceCriteria: ["LLM patch is rejected", "User patch can unlock revision intentionally"],
        acceptanceChecks: [],
        attachments: [],
        todos: [],
        updatedAt: now
      }
    ],
    edges: [
      { id: "edge-project-json", source: "node-project", target: "node-json-model", label: "stores" },
      { id: "edge-json-canvas", source: "node-json-model", target: "node-canvas", label: "renders" },
      { id: "edge-json-orchestrator", source: "node-json-model", target: "node-orchestrator", label: "feeds context" },
      { id: "edge-policy-orchestrator", source: "node-approved-contract", target: "node-orchestrator", label: "guards edits" }
    ],
    updatedAt: now
  };

  return { project, flow };
}
