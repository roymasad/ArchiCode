import type { ProjectSettings } from "./schema";
import { gaiaAgent, pandoraAgent } from "./agentIdentities";

export const archicodeCapabilityVersion = "2026-07-17.3";

export type ArchicodeCapabilityDigest = {
  version: string;
  product: string;
  workflow: string[];
  researchChat: {
    can: string[];
    cannot: string[];
  };
  graphAndPlanning: string[];
  implementationAndRuntime: string[];
  workspaceAndIntegrations: string[];
  userInterfaceOnly: string[];
};

/**
 * Compact, provider-neutral product picture used anywhere an agent needs to
 * explain ArchiCode itself. Keep this focused on durable capabilities rather
 * than individual buttons or renderer implementation details.
 */
export function archicodeCapabilityDigest(): ArchicodeCapabilityDigest {
  return {
    version: archicodeCapabilityVersion,
    product: "ArchiCode is a local, visual-first Electron harness that keeps a durable software-planning graph beside the target codebase and coordinates research, implementation, verification, runtime, and debugging work from that graph.",
    workflow: [
      "Open or create a project, or map an existing codebase into flows, nodes, subflows, groups, and labeled edges.",
      "Use scoped Research chats to understand the project, refine architecture and requirements, and prepare reviewed graph or queue actions.",
      `Use AI Implement with ${gaiaAgent.name}, Build, Run App, acceptance checks, and AI Debug with ${pandoraAgent.name} to change and verify the target codebase while keeping graph truth current.`,
      "Review structural graph changes, run targets, source proposals, permissions, plans, diffs, and generated artifacts before risky changes are applied."
    ],
    researchChat: {
      can: [
        "Inspect scoped graph context, project conventions, selected nodes, project files, Git history/diffs, runs, traces, artifacts, runtime services, configured MCP tools, and web sources when enabled.",
        "Perform reversible visual canvas actions when explicitly requested: select one or more nodes or groups, switch the visible flow/detail flow, fit targets, center, pan, and zoom.",
        "Propose reviewed updates to project metadata, flows, nodes, subflows, edges, notes, acceptance checks, implementation-scope hints, run targets, and implementation/build/debug queue actions; Research can create node groups and assign nodes to them, while group renaming/color/deletion remains a direct user control.",
        "Help sync graph truth after external source edits and monitor queued work without pretending a proposal is already complete.",
        "Inspect configured Run App profiles, discover read-only emulator/simulator/device targets, inspect live runtime status and logs, and prepare approval-gated start, stop, or restart actions for exact runtime targets.",
        "Delegate substantial investigation to Sherlock, evidence-backed test/visual/runtime audits to Delphi, read-only graph assessment or proposal-only graph design to Picasso, and approval-gated merge-conflict resolution to Solomon when those capabilities are enabled. Delphi can reuse or approval-gated start an explicit Run App profile, including desktop targets and Android/iOS emulators, wait for readiness, audit it, and stop only the runtime/target it started."
      ],
      cannot: [
        `Edit target source files directly; normal implementation belongs to ${gaiaAgent.title} through AI Implement, while focused repairs belong to ${pandoraAgent.title} through AI Debug.`,
        "Silently apply review-gated graph, source, runtime, provider, security, MCP, or skill changes.",
        "Treat implementation-scope hints, visual placement, groups, or freeform edge labels as permissions or a hidden typed dependency system."
      ]
    },
    graphAndPlanning: [
      "Flows, nested detail subflows, user-visible node groups, freeform labeled edges, node stages/flags, notes, todos, attachments, custom properties, reusable node rules, visuals, acceptance criteria, and structured acceptance checks.",
      "Best-effort implementation-scope mappings from graph nodes to files, directories, classes, functions, and symbols, with provenance and freshness metadata.",
      "Imported relationships retain compact source evidence, confidence, origin, verification, and freshness; stale relationships are reconciled deterministically after ordinary project reloads, while the read-only Code Knowledge Map exposes functional communities and source-backed inspection without sending the full evidence graph to the model.",
      "A local-only bounded code-detail snapshot maps files, symbols, containment, resolved dependencies, runtime links, and only unambiguous call targets; users can explore it directly and agents can query bounded search, neighbor, path, or impact results while the full snapshot stays outside normal context.",
      "Codebase onboarding/mapping, graph-change history, ignored and approved/locked graph state, JSON project/flow import and export, and draw.io/diagrams.net XML import and export."
    ],
    implementationAndRuntime: [
      "Sequential write-capable Agent Work Queue with planning, code, review, verification, retry, cancellation, failure classification, artifacts, todos, and permission gates.",
      `Project/flow/multi-node/no-scope implementation scopes with ${gaiaAgent.name}, fast/high implementation effort, module-aware run targets, finite build verification, acceptance-test authoring/execution, runtime services, bug incidents, and AI Debug recovery with ${pandoraAgent.name}.`,
      "Delphi can run existing finite project checks; control explicit web targets through Playwright; audit Android targets through ADB; capture iOS simulator evidence through simctl; use existing Appium sessions for richer mobile interaction; persist screenshots; and propose separately approved Playwright/Appium downloads in ArchiCode's managed cache without adding project dependencies.",
      "Manual/offline, Codex App Local, Claude Local, OpenAI-compatible, and Anthropic-compatible provider paths with model-aware context budgets and usage/cost tracking when providers report it."
    ],
    workspaceAndIntegrations: [
      "Read-only project file browser and previews, local project console, Git status/diffs/history/init/commit/pull/push/existing-branch switching, AI-assisted commit-message drafting, artifact browser, run trace, errors, questions, plans, and source-diff review.",
      "Project-local skills, stdio and Streamable HTTP MCP clients, permissioned MCP use, and an optional authenticated localhost MCP host for external coding agents.",
      "Project templates, LLM-assisted existing-codebase mapping, runtime/build command inference, editable 2D and read-only navigable 3D graph views, plus a read-only Code Knowledge Map, themes/canvas appearance, node arrangement tools, graph search, customizable keyboard shortcuts, system notifications, and update checks."
    ],
    userInterfaceOnly: [
      "Users can fork/archive/cancel/export Research chats, choose personality and verbosity, attach images and text documents, use speech input and text-to-speech, and inspect per-message/session context and LLM usage.",
      "Users directly control 2D/3D/knowledge-map view choice, node dragging/layout/arrangement, node-group editing, manual/automatic review modes, approvals, provider/security settings, runtime controls, Git actions, and project-state repair/removal. Research may perform only explicitly requested reversible 2D canvas selection and viewport navigation."
    ]
  };
}

/** Secret-free snapshot for questions about the current project's app options. */
export function archicodeCurrentProjectOptions(settings: ProjectSettings): Record<string, unknown> {
  const subagents = settings.agentTools.subagents ?? {
    mergeConflictResolution: true,
    graphReconciliation: true,
    sherlockResearch: true,
    delphiTesting: true
  };
  return {
    appearance: {
      canvasBackground: settings.canvasBackground,
      canvasEdgeStyle: settings.canvasEdgeStyle
    },
    reviewAndApproval: {
      patchReviewMode: settings.patchReviewMode,
      planningReviewMode: settings.planningReviewMode,
      codeReviewMode: settings.codeReviewMode,
      researchGraphAutoApprove: settings.researchAutoApproveGraphChanges,
      autoApproveShellCommands: settings.autoApproveShellCommands,
      stopOnUnansweredQuestions: settings.stopOnUnansweredQuestions
    },
    agentTools: {
      projectFiles: settings.agentTools.projectFiles,
      runArtifacts: settings.agentTools.runArtifacts,
      console: settings.agentTools.console,
      subagents: {
        solomonMergeResolution: subagents.mergeConflictResolution,
        picassoGraphDesign: subagents.graphReconciliation,
        sherlockResearch: subagents.sherlockResearch,
        delphiTesting: subagents.delphiTesting
      }
    },
    context: {
      budgetMode: settings.contextBudgetMode,
      tokenBudget: settings.contextTokenBudget,
      compactionThreshold: settings.compactionThreshold,
      builder: settings.contextBuilder,
      graphChangeRetention: settings.graphChangeRetention
    },
    security: {
      filesystemPolicy: settings.filesystem.policy,
      blockOutsideProjectPaths: settings.filesystem.blockOutsideProjectPaths,
      additionalAllowedRootCount: settings.filesystem.allowedRoots.length,
      reusableShellPolicyCount: settings.shellPolicies.length
    },
    webSearch: settings.webSearch,
    notifications: settings.notifications,
    skills: {
      enabledSkillIds: settings.skills.enabledSkillIds
    },
    mcp: {
      enabledServers: settings.mcp.servers.filter((server) => server.enabled).map((server) => ({
        id: server.id,
        label: server.label,
        transport: server.transport,
        trusted: server.trusted,
        toolCount: server.tools.length
      }))
    },
    externalMcpHost: {
      enabled: settings.externalMcpHost.enabled,
      host: settings.externalMcpHost.host,
      port: settings.externalMcpHost.port,
      requireToken: settings.externalMcpHost.requireToken,
      writeMode: settings.externalMcpHost.writeMode
    },
    commandsAndTargets: {
      defaultBuildCommand: settings.defaultBuildCommand,
      defaultRunCommand: settings.defaultRunCommand,
      runTargets: settings.runTargetProfiles.map((profile) => ({
        id: profile.id,
        label: profile.label,
        kind: profile.kind,
        cwd: profile.cwd,
        targetRequired: profile.targetRequired
      }))
    },
    providers: settings.providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      kind: provider.kind,
      enabled: provider.enabled,
      model: provider.model,
      localSandbox: provider.localSandbox
    }))
  };
}
