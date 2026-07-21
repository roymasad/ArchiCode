import { z } from "zod";

export const nodeStageSchema = z.enum([
  "planned",
  "plan-approved",
  "working",
  "draft",
  "draft-rejected",
  "draft-approved-production"
]);

export const nodeFlagSchema = z.enum([
  // "changed", "needs-attention", and "modified-not-built" are dirty bits that a
  // verified build clears (see updateRunNodeOutcome/reconcileVerifiedNodeBuildFlags
  // in storage.ts). "has-diff" is NOT a dirty bit: it is a durable historical
  // marker that a source diff was ever linked to this node, and is intentionally
  // never cleared. Do not treat "has-diff" as pending/unbuilt work.
  "changed",
  "has-diff",
  "needs-attention",
  "has-attachments",
  "llm-question",
  "modified-not-built",
  "user-approved"
]);

const colorHexSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a 6-digit hex color like #7bc6d5");
export const nodeVisualShapeSchema = z.enum([
  "rounded",
  "rectangle",
  "capsule",
  "document",
  "database",
  "note",
  "ellipse",
  "diamond",
  "hexagon",
  "parallelogram",
  "cloud",
  "actor"
]);

export const nodeVisualSchema = z.object({
  backgroundColor: colorHexSchema.optional(),
  shape: nodeVisualShapeSchema.optional()
}).default({});

export const customNodePropertyTypeSchema = z.enum(["text", "long-text", "number", "checkbox", "date", "color", "url"]);

export const customNodePropertySchema = z.object({
  id: z.string(),
  label: z.string().trim().min(1).max(80),
  type: customNodePropertyTypeSchema.default("text")
});

export const providerKindSchema = z.enum(["openai-compatible", "anthropic-compatible", "offline-manual", "codex-local", "claude-local", "opencode-local", "antigravity-local", "grok-local", "kimi-local"]);
export const noteKindSchema = z.enum(["user-note", "llm-question", "user-answer", "system-note"]);
export const issuePrioritySchema = z.enum(["low", "normal", "high", "urgent"]);
export const noteCategorySchema = z.enum(["note", "decision", "bug", "task"]);
export const runPhaseSchema = z.enum([
  "planning",
  "awaiting-plan-review",
  "coding",
  "awaiting-code-review",
  "debugging",
  "needs-replan",
  "verifying",
  "complete"
]);
export const runStatusSchema = z.enum([
  "preparing",
  "queued",
  "needs-permission",
  "running",
  "planning",
  "awaiting-plan-review",
  "coding",
  "awaiting-code-review",
  "debugging",
  "needs-replan",
  "verifying",
  "succeeded",
  "failed",
  "cancelled"
]);
export const permissionDecisionSchema = z.enum(["pending", "allowed", "denied"]);

export const shellRiskSchema = z.enum(["low", "medium", "high"]);
export const filesystemPolicySchema = z.enum(["read-only", "project-write", "full-access"]);
export const canvasBackgroundSchema = z.enum(["neutral-gray", "graphite", "cool-mist", "soft-blue", "warm-paper", "deep-slate"]);
export const canvasEdgeStyleSchema = z.enum(["current", "curved"]);
// Retention window for resolved (implemented/obsolete) graph-change ledger
// records. Once a resolved record is older than this, it is folded into a cold
// archive on project load and dropped from the hot JSONL. Pending records are
// always retained regardless of age. "never" disables compaction.
export const graphChangeRetentionSchema = z.enum(["1day", "1week", "2weeks", "1month", "3months", "never"]);

const textOrTextListSchema = z.preprocess((value) => {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.join("\n");
  }
  return value;
}, z.string());

export const filesystemSecuritySchema = z.object({
  policy: filesystemPolicySchema.default("project-write"),
  allowedRoots: z.array(z.string()).default([]),
  blockOutsideProjectPaths: z.boolean().default(true)
});

export const webSearchProviderSchema = z.enum(["native", "brave"]);

export const webSearchSettingsSchema = z.object({
  provider: webSearchProviderSchema.default("native"),
  enabled: z.boolean().default(false),
  requirePerRunApproval: z.boolean().default(true),
  persistSearchArtifacts: z.boolean().default(true)
});

export const verificationCommandSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  required: z.boolean().default(true),
  timeout: z.number().int().positive().default(600000)
});

export const verificationSettingsSchema = z.object({
  commands: z.array(verificationCommandSchema).optional(),
  autoDetect: z.boolean().default(true)
}).optional();

export const agentToolSettingsSchema = z.object({
  projectFiles: z.boolean().default(true),
  runArtifacts: z.boolean().default(true),
  console: z.boolean().default(true),
  subagents: z.object({
    mergeConflictResolution: z.boolean().default(true),
    graphReconciliation: z.boolean().default(true),
    sherlockResearch: z.boolean().default(true),
    delphiTesting: z.boolean().default(true)
  }).optional()
}).default({
  projectFiles: true,
  runArtifacts: true,
  console: true,
  subagents: {
    mergeConflictResolution: true,
    graphReconciliation: true,
    sherlockResearch: true,
    delphiTesting: true
  }
});

export const localEnvironmentSettingsSchema = z.object({
  operatingSystem: z.string().default("unknown"),
  agentShell: z.string().default(""),
  projectRoot: z.string().default(".")
}).optional();

export const speechModelIdSchema = z.enum(["base", "base.en"]);

export const speechSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  modelId: speechModelIdSchema.default("base"),
  language: z.string().default("english"),
  translateToEnglish: z.boolean().default(false),
  threads: z.number().int().min(1).max(16).default(4)
}).default({
  enabled: false,
  modelId: "base",
  language: "english",
  translateToEnglish: false,
  threads: 4
});

export const ttsModelIdSchema = z.enum(["kokoro-82m"]);
export const ttsVoiceIdSchema = z.enum(["af_heart", "af_bella", "af_nicole", "af_sarah", "am_adam", "am_puck", "bf_emma", "bm_daniel"]);

export const ttsSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  modelId: ttsModelIdSchema.default("kokoro-82m"),
  voiceId: ttsVoiceIdSchema.default("af_heart"),
  speed: z.number().min(0.8).max(1.2).default(1),
  autoplay: z.boolean().default(false)
}).default({
  enabled: false,
  modelId: "kokoro-82m",
  voiceId: "af_heart",
  speed: 1,
  autoplay: false
});

export const projectSkillSettingsSchema = z.object({
  enabledSkillIds: z.array(z.string()).default([])
}).default({ enabledSkillIds: [] });

export const mcpServerTransportSchema = z.enum(["stdio", "streamable-http"]);

export const mcpServerSchema = z.object({
  id: z.string(),
  label: z.string(),
  transport: mcpServerTransportSchema.default("stdio"),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.array(z.object({
    name: z.string(),
    value: z.string().optional()
  })).default([]),
  headers: z.array(z.object({
    name: z.string(),
    value: z.string().optional()
  })).default([]),
  defaultToolsApprovalMode: z.enum(["auto", "prompt", "approve"]).optional(),
  url: z.string().optional(),
  enabled: z.boolean().default(false),
  trusted: z.boolean().default(false),
  source: z.enum(["project", "imported-codex", "imported-json", "registry"]).default("project"),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    inputSchema: z.unknown().optional()
  })).default([]),
  resources: z.array(z.object({
    uri: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    mimeType: z.string().optional()
  })).default([]),
  prompts: z.array(z.object({
    name: z.string(),
    description: z.string().optional()
  })).default([]),
  lastRefreshedAt: z.string().optional(),
  lastError: z.string().optional()
});

export const mcpSettingsSchema = z.object({
  servers: z.array(mcpServerSchema).default([])
}).default({ servers: [] });

export const externalMcpHostSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.literal("127.0.0.1").default("127.0.0.1"),
  port: z.number().int().min(1024).max(65535).default(37373),
  requireToken: z.boolean().default(true),
  writeMode: z.literal("apply").default("apply")
}).default({
  enabled: false,
  host: "127.0.0.1",
  port: 37373,
  requireToken: true,
  writeMode: "apply"
});

export const shellPolicySchema = z.object({
  id: z.string(),
  command: z.string(),
  cwd: z.string().optional(),
  env: z.array(z.object({
    name: z.string(),
    value: z.string().optional()
  })).default([]),
  risk: shellRiskSchema.default("medium"),
  filesystemPolicy: filesystemPolicySchema.default("project-write"),
  allowedRoots: z.array(z.string()).default([]),
  reusable: z.boolean().default(false),
  createdAt: z.string()
});

export const artifactSchema = z.object({
  id: z.string(),
  type: z.enum(["summary", "diff", "log", "attachment", "screenshot", "instructions", "generated-file", "chat-artifact", "context-manifest", "memory", "plan"]),
  title: z.string(),
  path: z.string(),
  nodeId: z.string().optional(),
  noteId: z.string().optional(),
  runId: z.string().optional(),
  chatId: z.string().optional(),
  mediaType: z.string().optional(),
  status: z.enum(["pending-review", "partially-applied", "applied", "rejected"]).optional(),
  summary: z.string().optional(),
  promptSummary: z.string().optional(),
  providerSummary: z.string().optional(),
  planOutputAt: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  revision: z.number().int().positive().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional()
});

// Structured, verifiable counterpart to the free-text `acceptanceCriteria`.
// Each check binds one criterion to an LLM-authored test and records the last
// build-time verdict. Nodes gate their dirty-flag clearing on these: a verified
// build only clears a node once every attached check is "passing" (see
// nodeAcceptanceChecksSatisfied). acceptanceCriteria stays as the human-readable
// spec; acceptanceChecks is the machine checklist layered on top of it.
export const acceptanceCheckStatusSchema = z.enum(["unverified", "passing", "failing"]);
export const nodeModuleProfileModeSchema = z.enum(["auto", "manual", "none"]);
export const implementationScopeRelationSchema = z.enum(["own", "share", "cover"]);
export const implementationScopeTargetKindSchema = z.enum(["file", "directory", "class", "function", "symbol"]);
export const implementationScopeSourceSchema = z.enum(["codebase-importer", "implementation-agent", "chat-agent", "user"]);
export const implementationScopeClaimSchema = z.object({
  relation: implementationScopeRelationSchema,
  kind: implementationScopeTargetKindSchema,
  path: z.string().trim().min(1),
  symbol: z.string().trim().min(1).optional()
});
export const implementationScopeSchema = z.object({
  // These are deterministic, best-effort navigation hints rather than edit
  // permissions or authoritative ownership declarations. Keep the list bounded
  // so node JSON and agent context stay compact.
  source: implementationScopeSourceSchema.optional(),
  analyzerVersion: z.number().int().positive().optional(),
  updatedByRunId: z.string().optional(),
  // Optional for backwards compatibility with scopes written before this
  // field existed. Every current producer stamps the time it last evaluated
  // the claims so users and agents can judge how stale the hints may be.
  checkedAt: z.string().datetime().optional(),
  claims: z.array(implementationScopeClaimSchema).max(24).default([])
});
export const acceptanceCheckSchema = z.object({
  id: z.string(),
  criterion: z.string(),
  testCommand: z.string().optional(),
  testFilePath: z.string().optional(),
  // Name of the specific test/describe block that verifies this criterion, so the
  // UI can distinguish multiple checks that share one test file.
  testName: z.string().optional(),
  status: acceptanceCheckStatusSchema.default("unverified"),
  verifiedByRunId: z.string().optional(),
  evidence: z.string().optional(),
  updatedAt: z.string().optional()
});

/**
 * Stable identity shared by nodes that depict the same subject in different flows.
 * A flow is a perspective; this reference is the join back to the code-derived subject.
 */
export const graphSubjectRefSchema = z.object({
  id: z.string().trim().min(1),
  kind: z.enum(["code", "external-system", "concept", "context-note"]),
  evidenceStatus: z.enum(["observed", "inferred", "context"]),
  /** Deterministic fingerprint of the evidence scope when one is available. */
  scopeFingerprint: z.string().trim().min(1).optional()
});

export const archicodeNodeSchema = z.object({
  id: z.string(),
  type: z.string().trim().min(1),
  title: z.string(),
  description: z.string(),
  stage: nodeStageSchema,
  ignored: z.boolean().default(false),
  flags: z.array(nodeFlagSchema).default([]),
  locked: z.boolean().default(false),
  visual: nodeVisualSchema,
  position: z.object({ x: z.number(), y: z.number() }),
  size: z.object({ width: z.number(), height: z.number() }).optional(),
  parentId: z.string().optional(),
  subflowId: z.string().optional(),
  groupId: z.string().optional(),
  techStack: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  acceptanceChecks: z.array(acceptanceCheckSchema).default([]),
  subjectRef: graphSubjectRefSchema.optional(),
  implementationScope: implementationScopeSchema.optional(),
  moduleProfileMode: nodeModuleProfileModeSchema.optional(),
  // Binds this node to a runTargetProfile (a monorepo module / buildable unit).
  // Acceptance-check verification runs a check's test in this profile's cwd and
  // can fall back to the profile's testCommand when a check has none.
  moduleProfileId: z.string().optional(),
  customProperties: z.record(z.string()).default({}),
  ruleIds: z.array(z.string()).optional(),
  attachments: z.array(artifactSchema).default([]),
  todos: z.array(z.object({
    id: z.string(),
    text: z.string(),
    done: z.boolean().default(false)
  })).default([]),
  updatedAt: z.string().default("")
});

const relativeNodePositionHintSchema = z.object({
  relativeToNodeId: z.string(),
  placement: z.enum(["above", "below", "left", "right"])
});

export const architectureIntentKindSchema = z.enum(["guidance", "decision", "policy"]);
export const architectureIntentStatusSchema = z.enum(["active", "disabled", "superseded"]);
export const architecturePolicySeveritySchema = z.enum(["info", "warning", "error"]);
export const architecturePolicyEnforcementSchema = z.enum(["advisory", "enforced"]);

const architecturePolicyPathGlobSchema = z.string().trim().min(1).max(240);
export const architecturePolicyConstraintKindSchema = z.enum([
  "forbidden-dependency",
  "required-dependency",
  "allowed-dependency",
  "no-cycles",
  "forbidden-import",
  "file-convention",
  "required-companion-file",
  "required-node-metadata",
  "node-relationship",
  "no-orphan-nodes"
]);
export const architecturePolicyNodeScopeSchema = z.enum(["attached", "flow", "subflow", "project"]);
export const architecturePolicyMetadataFieldSchema = z.enum([
  "description",
  "tech-stack",
  "acceptance-criteria",
  "acceptance-check",
  "passing-acceptance-check",
  "implementation-scope",
  "documentation"
]);
export const architecturePolicyFileNameStyleSchema = z.enum(["kebab-case", "camelCase", "PascalCase", "snake_case"]);
export const forbiddenDependencyConstraintSchema = z.object({
  kind: z.literal("forbidden-dependency"),
  fromPathGlobs: z.array(architecturePolicyPathGlobSchema).min(1).max(32),
  toPathGlobs: z.array(architecturePolicyPathGlobSchema).min(1).max(32),
  includeRuntime: z.boolean().default(false)
});
export const requiredDependencyConstraintSchema = z.object({
  kind: z.literal("required-dependency"),
  fromPathGlobs: z.array(architecturePolicyPathGlobSchema).min(1).max(32),
  toPathGlobs: z.array(architecturePolicyPathGlobSchema).min(1).max(32),
  includeRuntime: z.boolean().default(false)
});
export const allowedDependencyConstraintSchema = z.object({
  kind: z.literal("allowed-dependency"),
  fromPathGlobs: z.array(architecturePolicyPathGlobSchema).min(1).max(32),
  allowedPathGlobs: z.array(architecturePolicyPathGlobSchema).min(1).max(64),
  includeRuntime: z.boolean().default(false)
});
export const noCyclesConstraintSchema = z.object({
  kind: z.literal("no-cycles"),
  pathGlobs: z.array(architecturePolicyPathGlobSchema).min(1).max(32),
  includeRuntime: z.boolean().default(false)
});
export const forbiddenImportConstraintSchema = z.object({
  kind: z.literal("forbidden-import"),
  fromPathGlobs: z.array(architecturePolicyPathGlobSchema).min(1).max(32),
  importGlobs: z.array(architecturePolicyPathGlobSchema).min(1).max(64),
  importedNames: z.array(z.string().trim().min(1).max(160)).max(64).default([])
});
export const fileConventionConstraintSchema = z.object({
  kind: z.literal("file-convention"),
  pathGlobs: z.array(architecturePolicyPathGlobSchema).min(1).max(32),
  allowedPathGlobs: z.array(architecturePolicyPathGlobSchema).max(64).default([]),
  fileNameStyle: architecturePolicyFileNameStyleSchema.optional(),
  requiredSuffix: z.string().trim().min(1).max(80).optional()
});
export const requiredCompanionFileConstraintSchema = z.object({
  kind: z.literal("required-companion-file"),
  sourcePathGlobs: z.array(architecturePolicyPathGlobSchema).min(1).max(32),
  companionPathGlobs: z.array(architecturePolicyPathGlobSchema).min(1).max(64),
  match: z.enum(["same-stem", "any"]).default("same-stem")
});
export const requiredNodeMetadataConstraintSchema = z.object({
  kind: z.literal("required-node-metadata"),
  scope: architecturePolicyNodeScopeSchema.default("attached"),
  field: architecturePolicyMetadataFieldSchema
});
export const nodeRelationshipConstraintSchema = z.object({
  kind: z.literal("node-relationship"),
  scope: architecturePolicyNodeScopeSchema.default("attached"),
  mode: z.enum(["required", "forbidden"]).default("required"),
  direction: z.enum(["incoming", "outgoing", "either"]).default("either"),
  targetNodeTypes: z.array(z.string().trim().min(1).max(120)).max(32).default([])
});
export const noOrphanNodesConstraintSchema = z.object({
  kind: z.literal("no-orphan-nodes"),
  scope: architecturePolicyNodeScopeSchema.default("attached")
});
export const architecturePolicyConstraintSchema = z.discriminatedUnion("kind", [
  forbiddenDependencyConstraintSchema,
  requiredDependencyConstraintSchema,
  allowedDependencyConstraintSchema,
  noCyclesConstraintSchema,
  forbiddenImportConstraintSchema,
  fileConventionConstraintSchema,
  requiredCompanionFileConstraintSchema,
  requiredNodeMetadataConstraintSchema,
  nodeRelationshipConstraintSchema,
  noOrphanNodesConstraintSchema
]);

export const nodeRuleSchema = z.object({
  id: z.string(),
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  kind: architectureIntentKindSchema.optional(),
  status: architectureIntentStatusSchema.optional(),
  severity: architecturePolicySeveritySchema.optional(),
  enforcement: architecturePolicyEnforcementSchema.optional(),
  constraint: architecturePolicyConstraintSchema.optional(),
  decision: z.object({
    context: z.string().trim().optional(),
    alternatives: z.array(z.object({
      option: z.string().trim().min(1),
      reason: z.string().trim().min(1)
    })).max(24).default([]),
    consequences: z.array(z.string().trim().min(1)).max(24).default([])
  }).optional(),
  supersededBy: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const architecturePolicyEndpointSchema = z.object({
  entityKind: z.enum(["file", "node", "external", "pattern"]).default("file"),
  path: z.string().trim().min(1),
  line: z.number().int().positive().optional(),
  fact: z.string().trim().min(1).optional(),
  flowId: z.string().optional(),
  nodeId: z.string().optional()
});

export const architecturePolicyViolationSchema = z.object({
  id: z.string(),
  policyId: z.string(),
  policyTitle: z.string(),
  kind: architecturePolicyConstraintKindSchema,
  severity: architecturePolicySeveritySchema,
  enforcement: architecturePolicyEnforcementSchema,
  message: z.string(),
  source: architecturePolicyEndpointSchema,
  target: architecturePolicyEndpointSchema.optional(),
  checkedAt: z.string().datetime(),
  firstSeenAt: z.string().datetime()
});

export const architecturePolicyEvaluationSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  analyzerVersion: z.number().int().positive(),
  // Optional for backward compatibility with early runtime snapshots. New
  // evaluations use it to reject a cache produced from older policy text.
  policyFingerprint: z.string().optional(),
  violations: z.array(architecturePolicyViolationSchema).max(10000).default([]),
  stats: z.object({
    policiesEvaluated: z.number().int().nonnegative(),
    edgesChecked: z.number().int().nonnegative(),
    violations: z.number().int().nonnegative()
  })
});

export const graphEvidenceOriginSchema = z.enum(["extracted", "resolved", "inferred", "user"]);
export const graphEvidenceFreshnessSchema = z.enum(["current", "stale", "unknown"]);
export const graphEvidenceVerificationSchema = z.enum(["verified", "unresolved", "ambiguous"]);
export const graphEvidenceLocationSchema = z.object({
  path: z.string().trim().min(1),
  line: z.number().int().positive().optional(),
  symbol: z.string().trim().min(1).optional(),
  fact: z.string().trim().min(1).optional()
});
export const graphEdgeEvidenceSchema = z.object({
  origin: graphEvidenceOriginSchema,
  confidence: z.number().min(0).max(1),
  relationKinds: z.array(z.string().trim().min(1)).max(12).default([]),
  locations: z.array(graphEvidenceLocationSchema).max(16).default([]),
  analyzerVersion: z.number().int().positive().optional(),
  checkedAt: z.string().datetime().optional(),
  verification: graphEvidenceVerificationSchema.default("verified"),
  freshness: graphEvidenceFreshnessSchema.default("unknown")
});

export const flowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
  color: colorHexSchema.optional(),
  width: z.number().min(1).max(8).optional(),
  lineStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  animated: z.boolean().optional(),
  bidirectional: z.boolean().optional(),
  label: z.string().optional(),
  /** Stable evidence is shared; volatile checkedAt/freshness observations serialize to local runtime state. */
  evidence: graphEdgeEvidenceSchema.optional()
});

export const flowSubflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  ignored: z.boolean().default(false),
  parentNodeId: z.string().optional(),
  parentSubflowId: z.string().optional()
});

export const flowGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: colorHexSchema.optional()
});

export const codebaseMappingGranularitySchema = z.enum(["system", "module", "component", "file"]);
export type CodebaseMappingGranularity = z.infer<typeof codebaseMappingGranularitySchema>;

/** Maximum post-import LLM review partitions for each user-facing review-effort choice. */
export const codebaseReviewPartitionBudget = {
  light: 5,
  balanced: 10,
  deep: 15,
  ultra: 30
} as const;

export const architecturePerspectiveKindSchema = z.enum([
  "system-context",
  "product-capabilities",
  "user-journeys",
  "runtime-integrations",
  "data-persistence",
  "cloud-infrastructure",
  "modules-components",
  "dependency-health",
  "analysis-notes",
  "custom"
]);

export const flowPerspectiveSchema = z.object({
  kind: architecturePerspectiveKindSchema,
  source: z.enum(["codebase-importer", "user"]).default("codebase-importer"),
  generated: z.boolean().default(true),
  question: z.string().trim().min(1),
  confidence: z.enum(["high", "medium", "exploratory"]),
  evidenceBasis: z.array(z.string().trim().min(1)).max(16).default([]),
  limitations: z.array(z.string().trim().min(1)).max(12).default([]),
  checkedAt: z.string().datetime().optional(),
  coverage: z.object({
    subjects: z.number().int().nonnegative(),
    relations: z.number().int().nonnegative(),
    observedRelations: z.number().int().nonnegative(),
    inferredRelations: z.number().int().nonnegative()
  }).optional()
});

export const flowVisualIconSchema = z.enum([
  "boxes",
  "cloud",
  "compass",
  "cpu",
  "database",
  "layers",
  "network",
  "package",
  "route",
  "shield",
  "sparkles",
  "users",
  "workflow"
]);

export const flowVisualSchema = z.object({
  icon: flowVisualIconSchema.optional(),
  color: colorHexSchema.optional()
});

export const flowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  ignored: z.boolean().default(false),
  /** Durable identity for the canonical code-derived flow; its visible Evidence suffix is protected. */
  evidenceBackbone: z.boolean().optional(),
  perspective: flowPerspectiveSchema.optional(),
  visual: flowVisualSchema.optional(),
  nodes: z.array(archicodeNodeSchema),
  edges: z.array(flowEdgeSchema),
  subflows: z.array(flowSubflowSchema).default([]),
  groups: z.array(flowGroupSchema).default([]),
  updatedAt: z.string().default("")
});

export const llmPhaseSchema = z.enum([
  "planning",
  "coding",
  "debugging",
  "review",
  "verifying",
  "summarizing",
  "brainstorming"
]);

export const reasoningModeSchema = z.enum(["off", "low", "medium", "high"]);

export const phaseModelPolicySchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  reasoningMode: reasoningModeSchema.default("off"),
  maxOutputTokens: z.number().int().positive().optional(),
  modelOverride: z.string().optional(),
  enabledTools: z.array(z.enum(["web-search", "filesystem", "shell", "artifacts"])).default([])
});

export const phaseModelPoliciesSchema = z.object({
  planning: phaseModelPolicySchema.default({ temperature: 0.2, reasoningMode: "high", maxOutputTokens: 16000 }),
  coding: phaseModelPolicySchema.default({ temperature: 0.1, reasoningMode: "medium", maxOutputTokens: 64000 }),
  debugging: phaseModelPolicySchema.default({ temperature: 0.0, reasoningMode: "high", maxOutputTokens: 32000 }),
  review: phaseModelPolicySchema.default({ temperature: 0.1, reasoningMode: "medium", maxOutputTokens: 12000 }),
  verifying: phaseModelPolicySchema.default({ temperature: 0.0, reasoningMode: "low", maxOutputTokens: 4000 }),
  summarizing: phaseModelPolicySchema.default({ temperature: 0.1, reasoningMode: "low", maxOutputTokens: 8000 }),
  brainstorming: phaseModelPolicySchema.default({ temperature: 0.6, reasoningMode: "medium", maxOutputTokens: 24000 })
});

export const defaultPhaseModelPolicies = phaseModelPoliciesSchema.parse({});

export const subagentModelProfileSchema = z.enum(["picasso", "sherlock", "solomon", "delphi"]);

export const subagentModelPoliciesSchema = z.object({
  // Match the previous shared Research policy by default. These become
  // independent only when the user customizes a subagent card.
  picasso: phaseModelPolicySchema.default({ temperature: 0.6, reasoningMode: "medium", maxOutputTokens: 32000 }),
  sherlock: phaseModelPolicySchema.default({ temperature: 0.6, reasoningMode: "high", maxOutputTokens: 32000 }),
  solomon: phaseModelPolicySchema.default({ temperature: 0.6, reasoningMode: "medium", maxOutputTokens: 32000 }),
  delphi: phaseModelPolicySchema.default({ temperature: 0.1, reasoningMode: "high", maxOutputTokens: 32000 })
});

export const defaultSubagentModelPolicies = subagentModelPoliciesSchema.parse({});

// Per-model USD pricing, in dollars per *million* tokens. Used to compute the
// persisted `costUsd` on each LLM usage record. `input`/`output` are required;
// the cache rates default inside computeLlmCost when omitted (cache-read ~10%
// of input, cache-write ~125% of input, mirroring Anthropic's convention).
export const modelPricingSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative().optional(),
  cacheWritePerMTok: z.number().nonnegative().optional()
});
export type ModelPricing = z.infer<typeof modelPricingSchema>;

export const contextLifecycleTierSchema = z.enum(["full", "compact", "compressed", "minimal-resumable"]);
export const contextLifecycleSchema = z.object({
  tier: contextLifecycleTierSchema,
  note: z.string().optional()
});
export type ContextLifecycle = z.infer<typeof contextLifecycleSchema>;

// Raw token usage from one or more LLM calls, aggregated across a turn's tool
// loop / thinking retries. `inputTokens` is the *non-cached* billable input
// (cache hits are split into `cacheReadTokens`/`cacheCreationTokens`), and
// `outputTokens` already includes `thinkingTokens` (shown separately as a
// detail, not double-billed). `unavailable` marks local CLI providers that
// expose no usage object (cost renders "n/a"); `estimated` marks heuristic
// token counts. `costUsd` is computed at capture time from the pricing table.
export const llmUsageSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  thinkingTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheCreationTokens: z.number().int().nonnegative().optional(),
  reasoningReplayState: z.enum(["received", "absent", "mixed"]).optional(),
  calls: z.number().int().positive().default(1),
  estimated: z.boolean().optional(),
  unavailable: z.boolean().optional(),
  costUsd: z.number().nonnegative().optional(),
  contextMode: z.enum(["compact", "full"]).optional(),
  contextLifecycleTier: contextLifecycleTierSchema.optional(),
  escalatedFromCompact: z.boolean().optional(),
  estimatedContextTokens: z.number().int().nonnegative().optional(),
  contextSections: z.array(z.object({
    label: z.string(),
    tokens: z.number().int().nonnegative(),
    detail: z.string().optional()
  })).optional()
});
export type LlmUsage = z.infer<typeof llmUsageSchema>;

export const runUsageByPhaseSchema = z.object({
  phase: llmPhaseSchema,
  usage: llmUsageSchema
});
export type RunUsageByPhase = z.infer<typeof runUsageByPhaseSchema>;

export const modelCapabilityProfileSchema = z.object({
  providerKind: providerKindSchema,
  model: z.string().optional(),
  supportsTemperature: z.boolean(),
  supportsReasoning: z.boolean(),
  supportsThinking: z.boolean(),
  supportsMaxOutputTokens: z.boolean(),
  supportsImageInput: z.boolean().default(false),
  reasoningField: z.enum(["reasoning", "reasoning_effort", "thinking", "prompt-only", "none"])
});

export const detectedProviderModelCapabilitySchema = z.object({
  supportsImageInput: z.boolean().optional(),
  contextWindowTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional()
});

export const providerSettingsSchema = z.object({
  id: z.string(),
  kind: providerKindSchema,
  label: z.string(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  contextWindowTokens: z.number().int().positive().optional(),
  detectedContextWindowTokens: z.number().int().positive().optional(),
  detectedAvailableModels: z.array(z.string()).default([]),
  detectedModelCapabilities: z.record(detectedProviderModelCapabilitySchema).default({}),
  openAiEndpointMode: z.enum(["auto", "responses", "chat-completions"]).optional(),
  detectedOpenAiEndpointMode: z.enum(["responses", "chat-completions"]).optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  localCommand: z.string().optional(),
  localProfile: z.string().optional(),
  outputVerbosity: z.enum(["low", "medium", "high"]).optional(),
  localSandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("read-only"),
  ephemeral: z.boolean().default(true),
  phaseModelPolicies: phaseModelPoliciesSchema.default(defaultPhaseModelPolicies),
  subagentModelPolicies: subagentModelPoliciesSchema.default(defaultSubagentModelPolicies),
  // Optional per-model USD/token pricing override (per million tokens). When
  // absent, the built-in default table in llmPricing.ts is used.
  pricing: modelPricingSchema.optional(),
  enabled: z.boolean().default(true)
});

export const contextBuilderSettingsSchema = z.object({
  includeNotes: z.boolean().default(true),
  includeArtifacts: z.boolean().default(true),
  includeRuns: z.boolean().default(true),
  includeSummaries: z.boolean().default(true),
  includeLockedNodes: z.boolean().default(true),
  recentRunLimit: z.number().int().min(0).max(50).default(8),
  artifactLimit: z.number().int().min(0).max(100).default(20)
});

export const semanticIndexSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  maxRelatedNodes: z.number().int().min(0).max(12).default(6)
}).default({ enabled: true, maxRelatedNodes: 6 });

export const runTargetProfileSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string().default("generic"),
  cwd: z.string().optional(),
  description: z.string().optional(),
  installCommand: z.string().optional(),
  setupCommand: z.string().optional(),
  buildCommand: z.string().optional(),
  testCommand: z.string().optional(),
  stopCommand: z.string().optional(),
  targetStopCommand: z.string().optional(),
  healthCommand: z.string().optional(),
  url: z.string().optional(),
  ports: z.array(z.number().int().positive().max(65535)).optional(),
  groupId: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  inferred: z.boolean().optional(),
  discoverCommand: z.string().optional(),
  targetPattern: z.string().optional(),
  targetPreferencePattern: z.string().optional(),
  defaultTargetId: z.string().optional(),
  targetRequired: z.boolean().default(false),
  launchCommand: z.string().optional(),
  waitCommand: z.string().optional(),
  readyPattern: z.string().optional(),
  notReadyPattern: z.string().optional(),
  readyTargetPattern: z.string().optional(),
  runtimeReadyPattern: z.string().optional(),
  diagnosticCommands: z.array(z.string()).default([]),
  recoveryCommands: z.array(z.string()).default([]),
  retryAfterRecovery: z.boolean().default(true),
  runCommand: z.string(),
  timeoutSeconds: z.number().int().positive().max(600).default(90)
});

export const runtimeServiceLogEntrySchema = z.object({
  at: z.string(),
  stream: z.enum(["system", "stdout", "stderr"]),
  text: z.string()
});

export const runtimeServiceSchema = z.object({
  id: z.string(),
  projectRoot: z.string(),
  profileId: z.string().optional(),
  label: z.string(),
  kind: z.string().default("generic"),
  status: z.enum(["starting", "running", "stopped", "failed", "stale"]),
  command: z.string(),
  cwd: z.string(),
  relativeCwd: z.string().default(""),
  pid: z.number().int().positive().optional(),
  url: z.string().optional(),
  targetId: z.string().optional(),
  runTargetId: z.string().optional(),
  targetStartedByService: z.boolean().optional(),
  ports: z.array(z.number().int().positive().max(65535)).default([]),
  startedAt: z.string().optional(),
  stoppedAt: z.string().optional(),
  lastOutputAt: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  logs: z.array(runtimeServiceLogEntrySchema).default([])
});

export const runEvidenceKindSchema = z.enum([
  "last-error",
  "trace-tail",
  "latest-diff",
  "runtime-log",
  "node-notes"
]);

export const runGuidanceSchema = z.object({
  text: z.string().default(""),
  evidence: z.array(runEvidenceKindSchema).default([]),
  runtimeServiceId: z.string().optional(),
  source: z.enum(["user", "research-agent"]).default("user")
}).default({ text: "", evidence: [], source: "user" });

export const runScopeSchema = z.object({
  kind: z.enum(["project", "flow", "nodes", "no-scope"]),
  flowId: z.string().optional(),
  nodeIds: z.array(z.string()).default([]),
  label: z.string().optional()
}).default({ kind: "flow", nodeIds: [] });

const normalizeLegacyEffort = (value: unknown): unknown => value === "normal" ? "high" : value;
export const runEffortSchema = z.preprocess(normalizeLegacyEffort, z.enum(["high", "fast", "auto"])).default("high");
export const implementationEffortSelectionSchema = z.preprocess(normalizeLegacyEffort, z.enum(["high", "fast"]));

export const runContextSummarySchema = z.object({
  items: z.array(z.object({
    label: z.string(),
    count: z.number().int().nonnegative(),
    detail: z.string().optional()
  })).default([]),
  reasons: z.array(z.string()).default([]),
  budget: z.object({
    estimatedTokens: z.number().int().nonnegative(),
    maxTokens: z.number().int().positive(),
    compactionThreshold: z.number().int().positive(),
    source: z.string()
  }).optional(),
  contextLifecycle: contextLifecycleSchema.optional()
}).default({ items: [], reasons: [] });

export const runImplementationCheckpointSchema = z.object({
  id: z.string(),
  phase: z.enum(["coding", "debugging"]),
  batchNumber: z.number().int().positive(),
  taskId: z.string().optional(),
  status: z.enum(["changed", "no-changes", "failed"]),
  summary: z.string().optional(),
  outputArtifactId: z.string().optional(),
  sourceDiffArtifactId: z.string().optional(),
  verification: z.object({
    command: z.string(),
    exitCode: z.number().int().nullable(),
    passed: z.boolean(),
    summary: z.string(),
    logArtifactId: z.string().optional()
  }).optional(),
  warnings: z.array(z.string()).default([]),
  quarantinedOperationsCount: z.number().int().nonnegative().default(0),
  startedAt: z.string(),
  completedAt: z.string().optional()
});

export const runImplementationTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string().optional(),
  status: z.enum(["todo", "doing", "done", "blocked"]).default("todo"),
  verificationCommand: z.string().optional(),
  lightVerificationCommand: z.string().optional(),
  batchBudget: z.number().int().positive().optional()
});

export const runImplementationStateSchema = z.object({
  currentBatch: z.number().int().nonnegative().default(0),
  maxBatches: z.number().int().positive().default(6),
  currentTaskId: z.string().optional(),
  tasks: z.array(runImplementationTaskSchema).default([]),
  needsMoreWork: z.boolean().optional(),
  needsReplan: z.object({
    reason: z.string(),
    suggestedQuestions: z.array(z.string()).default([])
  }).optional(),
  summary: z.string().optional(),
  checkpoints: z.array(runImplementationCheckpointSchema).default([])
});

export const runMemoryTodoSchema = z.object({
  title: z.string(),
  status: z.enum(["todo", "doing", "done", "blocked"]),
  notes: z.string().optional()
});

export const runMemoryCardSchema = z.object({
  summary: z.string().default(""),
  goal: z.string().default(""),
  currentPhase: runPhaseSchema.optional(),
  currentTask: z.string().optional(),
  todos: z.array(runMemoryTodoSchema).default([]),
  completedWork: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  touchedFiles: z.array(z.string()).default([]),
  failedAttempts: z.array(z.string()).default([]),
  verification: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  artifactIds: z.array(z.string()).default([]),
  nextStep: z.string().optional(),
  updatedAt: z.string().optional()
}).default({
  summary: "",
  goal: "",
  todos: [],
  completedWork: [],
  decisions: [],
  constraints: [],
  touchedFiles: [],
  failedAttempts: [],
  verification: [],
  openQuestions: [],
  artifactIds: []
});

export const notificationSettingsSchema = z.object({
  jobFinished: z.boolean().default(true),
  reviewRequired: z.boolean().default(true)
}).default({ jobFinished: true, reviewRequired: true });

export const researchAutoApproveGraphChangesSchema = z.object({
  enabled: z.boolean().default(false),
  includeDestructive: z.boolean().default(false)
}).default({ enabled: false, includeDestructive: false });

export const projectSettingsSchema = z.object({
  autoFocusSelectedNode: z.boolean().default(false),
  inspectorUtilityTabsExpanded: z.boolean().default(false),
  inspectorNodeAppearanceExpanded: z.boolean().default(false),
  activityArtifactTabsExpanded: z.boolean().default(false),
  canvasBackground: canvasBackgroundSchema.default("neutral-gray"),
  canvasEdgeStyle: canvasEdgeStyleSchema.default("current"),
  edgeLabelHistory: z.array(z.string()).default([]),
  customNodeTypes: z.array(z.string().trim().min(1)).default([]),
  customNodeProperties: z.array(customNodePropertySchema).default([]),
  nodeRules: z.array(nodeRuleSchema).optional(),
  notifications: notificationSettingsSchema,
  contextBudgetMode: z.enum(["auto", "manual"]).default("auto"),
  patchReviewMode: z.enum(["auto", "manual"]).default("auto"),
  planningReviewMode: z.enum(["auto", "manual"]).default("auto"),
  codeReviewMode: z.enum(["auto-apply", "manual"]).default("auto-apply"),
  autoApproveShellCommands: z.boolean().default(true),
  researchAutoApproveGraphChanges: researchAutoApproveGraphChangesSchema,
  stopOnUnansweredQuestions: z.boolean().default(true),
  purgeResolvedNotesOnApproval: z.boolean().default(false),
  graphChangeRetention: graphChangeRetentionSchema.default("1month"),
  contextTokenBudget: z.number().int().positive(),
  compactionThreshold: z.number().int().positive(),
  contextBuilder: contextBuilderSettingsSchema.default({
    includeNotes: true,
    includeArtifacts: true,
    includeRuns: true,
    includeSummaries: true,
    includeLockedNodes: true,
    recentRunLimit: 8,
    artifactLimit: 20
  }),
  semanticIndex: semanticIndexSettingsSchema,
  filesystem: filesystemSecuritySchema.default({
    policy: "project-write",
    allowedRoots: [],
    blockOutsideProjectPaths: true
  }),
  localEnvironment: localEnvironmentSettingsSchema,
  agentTools: agentToolSettingsSchema,
  webSearch: webSearchSettingsSchema.default({
    provider: "native",
    enabled: true,
    requirePerRunApproval: true,
    persistSearchArtifacts: true
  }),
  verification: verificationSettingsSchema,
  skills: projectSkillSettingsSchema,
  mcp: mcpSettingsSchema,
  externalMcpHost: externalMcpHostSettingsSchema,
  defaultBuildCommand: z.string(),
  defaultRunCommand: z.string(),
  buildTargetsLocked: z.boolean().default(false),
  runTargetProfiles: z.array(runTargetProfileSchema).default([]),
  environmentNotes: z.string(),
  stackAssumptions: z.array(z.string()).default([]),
  allowedShellCommands: z.array(z.string()).default([]),
  shellPolicies: z.array(shellPolicySchema).default([]),
  providers: z.array(providerSettingsSchema),
  tools: z.array(z.object({
    id: z.string(),
    kind: z.enum(["shell", "mcp", "skill", "artifact", "filesystem", "web-search"]),
    label: z.string(),
    enabled: z.boolean().default(true)
  })).default([])
});

export const projectSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  rootPath: z.string(),
  activeFlowId: z.string(),
  /** Content identity of the semantic graph committed with this project state. */
  graphVersion: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  settings: projectSettingsSchema,
  createdAt: z.string(),
  updatedAt: z.string().default("")
});

export const noteSchema = z.object({
  id: z.string(),
  flowId: z.string(),
  nodeId: z.string(),
  kind: noteKindSchema,
  author: z.enum(["user", "llm", "system"]),
  body: z.string(),
  category: noteCategorySchema.default("note"),
  priority: issuePrioritySchema.default("normal"),
  attachmentIds: z.array(z.string()).default([]),
  replyToNoteId: z.string().optional(),
  resolved: z.boolean().default(false),
  pinned: z.boolean().default(false),
  createdAt: z.string()
});

export const debugIncidentSchema = z.object({
  id: z.string(),
  source: z.enum(["manual-report", "note", "failed-run", "runtime-service"]),
  title: z.string(),
  description: z.string(),
  priority: issuePrioritySchema.default("normal"),
  status: z.enum(["open", "resolved"]).default("open"),
  flowId: z.string().optional(),
  nodeId: z.string().optional(),
  noteId: z.string().optional(),
  runId: z.string().optional(),
  runtimeServiceId: z.string().optional(),
  artifactIds: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const runSchema = z.object({
  id: z.string(),
  flowId: z.string(),
  nodeId: z.string().optional(),
  providerId: z.string(),
  status: runStatusSchema,
  phase: runPhaseSchema.default("planning"),
  // The phase the run was in when it reached a terminal state; recorded so
  // retry/resume decisions read a structured field instead of parsing logs.
  stoppedAtPhase: runPhaseSchema.optional(),
  // How this run was created when it was not user-initiated. The harness
  // branches on this (e.g. counting automatic verification debug attempts).
  origin: z.enum(["auto-verification-debug"]).optional(),
  // Automatic verification repairs stay within the originating run. This
  // counter limits that in-place recovery loop without creating child runs.
  automaticVerificationDebugAttempts: z.number().int().nonnegative().optional(),
  purpose: z.enum(["implement", "build-discovery", "run-discovery"]).optional(),
  effort: runEffortSchema,
  promptSummary: z.string(),
  command: z.string().optional(),
  runProfileId: z.string().optional(),
  runTargetId: z.string().optional(),
  cwd: z.string().optional(),
  env: z.array(z.object({
    name: z.string(),
    value: z.string().optional()
  })).default([]),
  risk: shellRiskSchema.optional(),
  retryOf: z.string().optional(),
  filesystemScope: z.object({
    policy: filesystemPolicySchema,
    cwd: z.string(),
    allowedRoots: z.array(z.string()).default([]),
    violations: z.array(z.string()).default([])
  }).optional(),
  webSearch: z.object({
    decision: permissionDecisionSchema,
    reason: z.string().optional()
  }).optional(),
  mcp: z.object({
    decision: permissionDecisionSchema,
    approvedServerIds: z.array(z.string()).default([]),
    deniedServerIds: z.array(z.string()).default([]),
    pendingServerIds: z.array(z.string()).default([]),
    pendingToolCall: z.object({
      serverId: z.string(),
      serverLabel: z.string(),
      toolName: z.string(),
      providerToolName: z.string(),
      argumentsJson: z.string().optional(),
      intent: z.string().optional(),
      phase: runPhaseSchema.optional()
    }).optional(),
    continuation: z.object({
      // "api" marks a paused API-provider phase: the phase replays after the
      // approval decision with the resume result injected into its prompt.
      providerKind: z.enum(["codex-local", "claude-local", "opencode-local", "antigravity-local", "grok-local", "kimi-local", "api"]),
      originalOutput: z.string(),
      resume: z.object({
        decision: z.enum(["approved", "denied"]),
        serverId: z.string(),
        serverLabel: z.string(),
        toolName: z.string(),
        providerToolName: z.string(),
        argumentsJson: z.string().optional(),
        intent: z.string().optional(),
        resultText: z.string().optional(),
        deniedReason: z.string().optional()
      }).optional()
    }).optional(),
    reason: z.string().optional()
  }).optional(),
  sourceReview: z.object({
    proposalArtifactId: z.string(),
    operationIndexes: z.array(z.number().int().nonnegative()).min(1),
    paths: z.array(z.string()).min(1),
    resumePhase: z.enum(["coding", "debugging"]),
    batchNumber: z.number().int().positive(),
    taskId: z.string().optional()
  }).optional(),
  sourceDeletionDecisions: z.array(z.object({
    path: z.string(),
    decision: z.enum(["accepted", "rejected"]),
    reason: z.string(),
    decidedAt: z.string()
  })).optional(),
  mcpToolCalls: z.array(z.object({
    id: z.string(),
    serverId: z.string(),
    serverLabel: z.string().optional(),
    toolName: z.string(),
    argumentsJson: z.string().optional(),
    status: z.enum(["started", "approval-required", "succeeded", "failed", "deferred"]),
    resultSummary: z.string().optional(),
    error: z.string().optional(),
    startedAt: z.string(),
    completedAt: z.string().optional()
  })).default([]),
  permission: z.object({
    decision: permissionDecisionSchema,
    reusablePolicyId: z.string().optional(),
    // Structured approval provenance: what the user's approval covered. The
    // harness branches on this; `reason` is display text only.
    grantedFor: z.enum(["coding-command", "debugging-command", "verification-command"]).optional(),
    reason: z.string().optional()
  }),
  contextArtifacts: z.array(z.string()).default([]),
  planArtifactIds: z.array(z.string()).default([]),
  sourceDiffArtifactIds: z.array(z.string()).default([]),
  // Snapshot the deterministic architecture violations that existed before
  // this source-changing run began. Retries inherit it so an unfixed policy
  // failure cannot become part of a newer global baseline and pass later.
  policyBaselineViolationIds: z.array(z.string()).max(10000).optional(),
  affectedNodeIds: z.array(z.string()).default([]),
  plannedCommands: z.array(z.string()).default([]),
  plannedAllowedRoots: z.array(z.string()).default([]),
  reviewDecisions: z.array(z.object({
    kind: z.enum(["planning", "code", "debugging"]),
    decision: z.enum(["accepted", "rejected", "skipped"]),
    reason: z.string().optional(),
    decidedAt: z.string()
  })).default([]),
  todos: z.array(z.object({
    id: z.string(),
    text: z.string(),
    // Phase todos the harness advances programmatically are tagged so the
    // match is structural; `text` stays free for display.
    kind: z.enum(["planning-phase", "coding-phase"]).optional(),
    status: z.enum(["todo", "doing", "done", "blocked"])
  })).default([]),
  logs: z.array(z.object({
    at: z.string(),
    stream: z.enum(["system", "stdout", "stderr"]),
    text: z.string()
  })).default([]),
  guidance: runGuidanceSchema.optional(),
  scope: runScopeSchema.optional(),
  contextSummary: runContextSummarySchema.optional(),
  runMemory: runMemoryCardSchema.optional(),
  // Aggregated LLM cost/usage across all phases of this run (and any subagents
  // it spawns). `usageByPhase` breaks it down per LLM phase; both are written
  // incrementally so the run-detail Cost line updates live as the run proceeds.
  usage: llmUsageSchema.optional(),
  usageByPhase: z.array(runUsageByPhaseSchema).optional(),
  implementation: runImplementationStateSchema.optional(),
  // Most recent executed verification/command result, recorded structurally so
  // failure classification does not have to parse exit codes back out of logs.
  // A missing exitCode means the process exited without a code (signal/unknown).
  lastVerification: z.object({
    command: z.string(),
    exitCode: z.number().int().optional(),
    at: z.string()
  }).optional(),
  runInstructions: z.string().optional(),
  errorDismissedAt: z.string().optional(),
  queueRemovedAt: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  createdAt: z.string()
});

export const microRunKindSchema = z.enum([
  "merge-resolution",
  "graph-reconciliation",
  "test-authoring",
  "sherlock-research",
  "delphi-testing"
]);
export type MicroRunKind = z.infer<typeof microRunKindSchema>;

export const microRunStatusSchema = z.enum(["running", "completed", "failed", "needs-clarification"]);
export type MicroRunStatus = z.infer<typeof microRunStatusSchema>;

// Tracks one subagent invocation as a standalone activity card in the chat,
// independent of the generic mcpToolCalls list (which is not distinctive
// enough for a subagent that can run for tens of minutes and write files).
export const subagentRunStatusSchema = z.enum(["awaiting-approval", "running", "completed", "blocked", "failed", "rejected"]);
export type SubagentRunStatus = z.infer<typeof subagentRunStatusSchema>;

export const subagentRunSchema = z.object({
  id: z.string(),
  kind: microRunKindSchema,
  status: subagentRunStatusSchema,
  title: z.string(),
  // The tool call arguments (conflictedFiles/resolutionStrategy/... or
  // resolvedFiles/resolutionSummary/...) needed to actually execute once approved.
  argumentsJson: z.string(),
  // The strategy the model proposed before approval; may be edited by the
  // user before they approve, in which case the edited value is what runs.
  proposedResolutionStrategy: z.string().optional(),
  // Why this subagent is being proposed. For graph reconciliation this should
  // explain the concrete stale-graph risk that was detected.
  reviewReason: z.string().optional(),
  // When Delphi finds several compatible Run App profiles and the user did
  // not name one, the approval card becomes an explicit multi-select target
  // choice. Approving that card authorizes the selected set as one audit.
  runtimeTargetSelection: z.object({
    options: z.array(z.object({
      profileId: z.string(),
      label: z.string(),
      kind: z.string(),
      targetRequired: z.boolean().default(false),
      defaultTargetId: z.string().optional()
    })).min(2),
    minSelections: z.number().int().positive().default(1),
    allowMultiple: z.boolean().default(true)
  }).optional(),
  selectedRuntimeTargetProfileIds: z.array(z.string()).optional(),
  // Corrective Delphi retries can inherit approval only after the host proves
  // their finite commands and target lifecycle match a prior approved run.
  approvalInheritedFromRunId: z.string().optional(),
  approvedRuntimeCommands: z.array(z.string()).optional(),
  approvedRuntimeCleanupCommands: z.array(z.string()).optional(),
  // Capability of the exact effective model selected for this Delphi run.
  // The renderer uses this to distinguish pending visual inspection from a
  // terminal/non-vision "not inspected" result while evidence streams in.
  imageInputSupport: z.enum(["supported", "unsupported", "unknown"]).optional(),
  progress: z.array(z.string()).default([]),
  // Runtime evidence captured independently of the model-authored summary.
  // Delphi uses this to keep screenshots observable in the chat card even if
  // the final model response forgets to repeat a tool artifact.
  artifacts: z.array(z.object({
    id: z.string(),
    label: z.string(),
    path: z.string(),
    mediaType: z.string()
  })).optional(),
  resultSummary: z.string().optional(),
  error: z.string().optional(),
  // Terminal cause is kept separate from the backward-compatible `failed`
  // state so the UI can distinguish a provider timeout from a failed audit.
  failureKind: z.enum(["timeout", "error"]).optional(),
  // Aggregated LLM cost/usage for this subagent's own multi-turn LLM session.
  usage: llmUsageSchema.optional(),
  // Bounded, secret-redacted completion diagnostics. These make provider/model
  // contract failures debuggable without persisting full prompts or tool args.
  diagnostics: z.object({
    responsePreview: z.string().optional(),
    responseRedacted: z.boolean().optional(),
    responseTruncated: z.boolean().optional(),
    repairAttempted: z.boolean().optional(),
    validationErrors: z.array(z.string()).optional(),
    toolCallNames: z.array(z.string()).optional(),
    visuallyAnalyzedArtifactIds: z.array(z.string()).optional()
  }).optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type SubagentRun = z.infer<typeof subagentRunSchema>;

export const mergeResolutionInputSchema = z.object({
  conflictedFiles: z.array(z.string()),
  resolutionStrategy: z.string().optional(),
  verificationCommands: z.array(z.string()).optional()
});
export type MergeResolutionInput = z.infer<typeof mergeResolutionInputSchema>;

export const mergeResolutionFinalCheckSchema = z.object({
  syntaxValid: z.boolean(),
  testsPassed: z.boolean(),
  lintPassed: z.boolean(),
  typecheckPassed: z.boolean(),
  issues: z.array(z.string())
});
export type MergeResolutionFinalCheck = z.infer<typeof mergeResolutionFinalCheckSchema>;

export const mergeResolutionOutputSchema = z.object({
  resolvedFiles: z.array(z.string()),
  verificationPassed: z.boolean(),
  verificationOutput: z.string().optional(),
  summary: z.string(),
  finalCheck: mergeResolutionFinalCheckSchema
});
export type MergeResolutionOutput = z.infer<typeof mergeResolutionOutputSchema>;

export const graphReconciliationInputSchema = z.object({
  mode: z.enum(["assess", "design", "refine", "reconcile"]).default("reconcile"),
  objective: z.string().optional(),
  scope: z.object({
    flowId: z.string().optional(),
    nodeIds: z.array(z.string()).default([])
  }).optional(),
  evidenceSummary: z.string().optional(),
  constraints: z.array(z.string()).default([]),
  detailLevel: z.enum(["focused", "detailed", "exhaustive"]).default("detailed"),
  resolvedFiles: z.array(z.string()).default([]),
  resolutionSummary: z.string().default(""),
  verificationResult: z.string().default("")
});
export type GraphReconciliationInput = z.infer<typeof graphReconciliationInputSchema>;

export const graphReconciliationDiscrepancySchema = z.object({
  nodeId: z.string(),
  nodeTitle: z.string(),
  issue: z.string(),
  proposedFix: z.string()
});
export type GraphReconciliationDiscrepancy = z.infer<typeof graphReconciliationDiscrepancySchema>;

export const graphReconciliationOutputSchema = z.object({
  graphChangeSet: z.any().optional(),
  nodesAffected: z.array(z.string()),
  reconciliationReport: z.string(),
  discrepancies: z.array(graphReconciliationDiscrepancySchema)
});
export type GraphReconciliationOutput = z.infer<typeof graphReconciliationOutputSchema>;

export const sherlockResearchInputSchema = z.object({
  objective: z.string().min(1),
  mode: z.enum(["codebase", "online", "topic", "mixed"]).default("mixed"),
  scope: z.string().optional(),
  codePaths: z.array(z.string()).default([]),
  evidenceRequirements: z.array(z.string()).default([])
});
export type SherlockResearchInput = z.infer<typeof sherlockResearchInputSchema>;

export const sherlockResearchFindingSchema = z.object({
  title: z.string(),
  detail: z.string(),
  evidence: z.array(z.object({
    source: z.string(),
    reference: z.string(),
    excerpt: z.string().optional()
  })).default([]),
  confidence: z.enum(["low", "medium", "high"])
});
export type SherlockResearchFinding = z.infer<typeof sherlockResearchFindingSchema>;

export const sherlockResearchOutputSchema = z.object({
  status: z.enum(["completed", "blocked"]).default("completed"),
  blockers: z.array(z.string()).default([]),
  summary: z.string(),
  findings: z.array(sherlockResearchFindingSchema).default([]),
  sources: z.array(z.object({
    label: z.string(),
    reference: z.string(),
    sourceType: z.enum(["project-file", "web", "documentation", "other"])
  })).default([]),
  openQuestions: z.array(z.string()).default([]),
  recommendedNextSteps: z.array(z.string()).default([])
});
export type SherlockResearchOutput = z.infer<typeof sherlockResearchOutputSchema>;

export const delphiTestPlatformSchema = z.enum(["web", "electron", "flutter", "android", "ios", "generic"]);
export type DelphiTestPlatform = z.infer<typeof delphiTestPlatformSchema>;

export const delphiTestingInputSchema = z.object({
  objective: z.string().min(1),
  mode: z.enum(["plan", "audit", "retest", "setup"]).default("audit"),
  scope: z.string().optional(),
  codePaths: z.array(z.string()).default([]),
  platforms: z.array(delphiTestPlatformSchema).default([]),
  observation: z.object({
    mode: z.enum(["visible", "headless"]).default("visible"),
    capture: z.enum(["key-steps", "final", "none"]).default("key-steps")
  }).default({ mode: "visible", capture: "key-steps" }),
  target: z.object({
    profileId: z.string().optional(),
    deviceId: z.string().optional(),
    baseUrl: z.string().optional(),
    appiumServerUrl: z.string().optional(),
    appiumSessionId: z.string().optional(),
    launch: z.enum(["never", "if-needed"]).default("never"),
    cleanup: z.enum(["stop-if-started", "keep-running"]).default("stop-if-started")
  }).optional(),
  setup: z.object({
    adapters: z.array(z.enum(["playwright", "appium"])).min(1),
    playwrightBrowsers: z.array(z.enum(["chromium", "firefox", "webkit"])).default(["chromium"]),
    appiumDrivers: z.array(z.enum(["uiautomator2", "xcuitest"])).default([]),
    resumeMode: z.enum(["audit", "retest"]).default("audit")
  }).optional(),
  acceptanceCriteria: z.array(z.string()).default([]),
  commands: z.array(z.string().min(1)).max(20).default([]),
  commandReview: z.object({
    details: z.array(z.object({
      command: z.string(),
      source: z.enum(["requested", "discovered"]),
      definition: z.string().optional()
    })).max(20).default([]),
    omittedDiscoveredCount: z.number().int().nonnegative().default(0)
  }).optional(),
  maxAttempts: z.number().int().min(1).max(5).default(5)
});
export type DelphiTestingInput = z.infer<typeof delphiTestingInputSchema>;

export const delphiToolchainPlanSchema = z.object({
  adapter: z.enum(["playwright", "flutter-integration-test", "appium", "project-native", "generic"]),
  status: z.enum(["ready", "missing", "unsupported"]),
  evidence: z.array(z.string()).default([]),
  installPlan: z.object({
    scope: z.enum(["managed-cache", "project", "system"]),
    packages: z.array(z.string()).default([]),
    actions: z.array(z.string()).default([]),
    requiresApproval: z.literal(true).default(true)
  }).optional()
});
export type DelphiToolchainPlan = z.infer<typeof delphiToolchainPlanSchema>;

export const delphiTestingOutputSchema = z.object({
  status: z.enum(["completed", "blocked", "needs-setup"]),
  verdict: z.enum(["passed", "failed", "blocked", "not-run"]),
  summary: z.string(),
  attempts: z.number().int().nonnegative().default(0),
  checks: z.array(z.object({
    name: z.string(),
    status: z.enum(["passed", "failed", "blocked", "skipped"]),
    command: z.string().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    outputSummary: z.string().optional(),
    evidence: z.array(z.string()).default([])
  })).default([]),
  findings: z.array(z.object({
    title: z.string(),
    severity: z.enum(["info", "low", "medium", "high", "critical"]),
    category: z.enum(["functional", "visual", "accessibility", "performance", "compatibility", "tooling", "other"]),
    detail: z.string(),
    reproductionSteps: z.array(z.string()).default([]),
    evidence: z.array(z.string()).default([])
  })).default([]),
  toolchains: z.array(delphiToolchainPlanSchema).default([]),
  artifacts: z.array(z.object({
    id: z.string().optional(),
    label: z.string(),
    path: z.string(),
    mediaType: z.string().optional()
  })).default([]),
  blockers: z.array(z.string()).default([]),
  recommendedNextSteps: z.array(z.string()).default([])
});
export type DelphiTestingOutput = z.infer<typeof delphiTestingOutputSchema>;

export const picassoGraphInputSchema = graphReconciliationInputSchema.extend({
  objective: z.string().min(1),
  mode: z.enum(["assess", "design", "refine", "reconcile"]).default("refine")
});
export type PicassoGraphInput = z.infer<typeof picassoGraphInputSchema>;

export const picassoGraphOutputSchema = z.object({
  status: z.enum(["completed", "blocked"]).default("completed"),
  blockers: z.array(z.string()).default([]),
  graphChangeSet: z.any().optional(),
  nodesAffected: z.array(z.string()).default([]),
  designReport: z.string(),
  reconciliationReport: z.string().optional(),
  discrepancies: z.array(graphReconciliationDiscrepancySchema).default([]),
  assumptions: z.array(z.string()).default([]),
  validationChecks: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([])
});
export type PicassoGraphOutput = z.infer<typeof picassoGraphOutputSchema>;

export const contextMemoryRecordSchema = z.object({
  id: z.string(),
  scope: z.enum(["project", "flow", "subflow", "node"]),
  scopeId: z.string(),
  flowId: z.string().optional(),
  nodeId: z.string().optional(),
  title: z.string(),
  summary: z.string(),
  facts: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  artifactIds: z.array(z.string()).default([]),
  runIds: z.array(z.string()).default([]),
  updatedAt: z.string()
});

export const contextManifestSchema = z.object({
  id: z.string(),
  flowId: z.string(),
  nodeId: z.string().optional(),
  scope: z.enum(["node", "subflow", "flow"]),
  budget: z.object({
    source: z.string(),
    modelContextTokens: z.number(),
    compactionThreshold: z.number(),
    estimatedSize: z.number()
  }),
  contextLifecycle: contextLifecycleSchema.optional(),
  selectedNodeIds: z.array(z.string()).default([]),
  includedNodeIds: z.array(z.string()).default([]),
  summarizedNodeIds: z.array(z.string()).default([]),
  includedNoteIds: z.array(z.string()).default([]),
  includedArtifactIds: z.array(z.string()).default([]),
  includedRunIds: z.array(z.string()).default([]),
  includedSummaryIds: z.array(z.string()).default([]),
  memoryRecordIds: z.array(z.string()).default([]),
  reasons: z.record(z.array(z.string())).default({}),
  createdAt: z.string()
});

export const graphChangeRecordSchema = z.object({
  id: z.string(),
  flowId: z.string(),
  actor: z.enum(["user", "accepted-research", "llm", "system"]),
  kind: z.enum([
    "flow-updated",
    "node-created",
    "node-updated",
    "node-deleted",
    "edge-created",
    "edge-updated",
    "edge-deleted",
    "subflow-created",
    "subflow-updated",
    "subflow-deleted",
    "group-created",
    "group-updated",
    "group-deleted",
    "node-subflow-linked"
  ]),
  summary: z.string(),
  nodeIds: z.array(z.string()).default([]),
  edgeIds: z.array(z.string()).default([]),
  subflowIds: z.array(z.string()).default([]),
  groupIds: z.array(z.string()).default([]),
  fieldPaths: z.array(z.string()).default([]),
  snippets: z.array(z.object({
    path: z.string(),
    before: z.string().optional(),
    after: z.string().optional()
  })).default([]),
  status: z.enum(["pending", "implemented", "obsolete"]).default("pending"),
  runId: z.string().optional(),
  createdAt: z.string(),
  resolvedAt: z.string().optional()
});

export const projectBundleSchema = z.object({
  rootPath: z.string(),
  project: projectSchema,
  flows: z.array(flowSchema),
  notes: z.array(noteSchema),
  incidents: z.array(debugIncidentSchema).default([]),
  runs: z.array(runSchema),
  artifacts: z.array(artifactSchema),
  summaries: z.array(artifactSchema),
  graphChanges: z.array(graphChangeRecordSchema).default([]),
  policyEvaluation: architecturePolicyEvaluationSchema.nullable().optional(),
  validationErrors: z.array(z.string()).default([])
});

export const llmPatchProposalSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  summary: z.string(),
  runSummary: z.object({
    goal: z.string().optional(),
    approach: z.string().optional(),
    assumptions: z.array(z.string()).default([]),
    verificationPlan: z.string().optional(),
    risks: z.array(z.string()).default([]),
    implementationStatus: z.enum(["complete", "continue", "blocked"]).optional(),
    notes: textOrTextListSchema.optional(),
    nextSourceSlice: z.string().optional(),
    verificationNotes: z.string().optional(),
    needsReplan: z.boolean().optional(),
    replanReason: z.string().optional(),
    implementationEffort: implementationEffortSelectionSchema.optional(),
    suggestedQuestions: z.array(z.string()).default([]),
    implementationTasks: z.array(z.object({
      id: z.string().optional(),
      title: z.string(),
      summary: z.string().optional(),
      verificationCommand: z.string().optional(),
      lightVerificationCommand: z.string().optional(),
      batchBudget: z.number().int().positive().optional()
    })).default([])
  }).optional(),
  operations: z.array(z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("update-node"),
      flowId: z.string(),
      patch: z.object({
        id: z.string()
      }).passthrough()
    }),
    z.object({
      kind: z.literal("add-note"),
      note: noteSchema.omit({ id: true, createdAt: true })
    }),
    z.object({
      kind: z.literal("resolve-note"),
      noteId: z.string(),
      resolved: z.boolean().default(true)
    }),
    z.object({
      kind: z.literal("delete-note"),
      noteId: z.string()
    }),
    z.object({
      kind: z.literal("add-artifact-reference"),
      artifact: artifactSchema
    }),
    z.object({
      kind: z.literal("propose-node"),
      flowId: z.string(),
      node: z.object({
        id: z.string().optional(),
        type: archicodeNodeSchema.shape.type.default("feature"),
        title: z.string(),
        description: z.string().default(""),
        stage: nodeStageSchema.default("planned"),
        ignored: z.boolean().default(false),
        flags: z.array(nodeFlagSchema).default(["changed"]),
        locked: z.boolean().default(false),
        visual: nodeVisualSchema,
        position: archicodeNodeSchema.shape.position.optional(),
        size: archicodeNodeSchema.shape.size.optional(),
        parentId: z.string().optional(),
        subflowId: z.string().optional(),
        groupId: z.string().optional(),
        techStack: z.array(z.string()).default([]),
        acceptanceCriteria: z.array(z.string()).default([]),
        acceptanceChecks: archicodeNodeSchema.shape.acceptanceChecks.default([]),
        implementationScope: archicodeNodeSchema.shape.implementationScope,
        moduleProfileMode: nodeModuleProfileModeSchema.optional(),
        moduleProfileId: z.string().optional(),
        customProperties: archicodeNodeSchema.shape.customProperties.default({}),
        attachments: z.array(artifactSchema).default([]),
        todos: archicodeNodeSchema.shape.todos.default([])
      })
    }),
    z.object({
      kind: z.literal("propose-edge"),
      flowId: z.string(),
      edge: flowEdgeSchema.partial({ id: true })
    }),
    z.object({
      kind: z.literal("propose-subflow"),
      flowId: z.string(),
      subflow: flowSubflowSchema.partial({ id: true })
    }),
    z.object({
      kind: z.literal("propose-graph-operation"),
      operation: z.record(z.unknown())
    }),
    z.object({
      kind: z.literal("propose-project-file"),
      path: z.string(),
      mode: z.enum(["create", "replace"]).default("create"),
      content: z.string(),
      reason: z.string().optional()
    }),
    z.object({
      kind: z.literal("propose-run-profile"),
      profile: runTargetProfileSchema,
      mode: z.enum(["create", "replace"]).default("create"),
      reason: z.string().optional()
    }),
    z.object({
      kind: z.literal("propose-source-file"),
      path: z.string(),
      action: z.enum(["create", "replace", "delete"]),
      content: z.string().optional(),
      baseSha256: z.string().optional(),
      nodeId: z.string().optional(),
      nodeIds: z.array(z.string().trim().min(1)).optional(),
      reason: z.string().optional(),
      testIntent: z.preprocess((value) => value === null ? undefined : value, z.string().optional())
    })
  ])).default([])
});

export const sourceFileSafetyResultSchema = z.object({
  safe: z.boolean(),
  requiresReview: z.boolean(),
  reason: z.string(),
  normalizedPath: z.string().optional(),
  risk: z.enum(["low", "medium", "high"])
});

export const appliedSourceFileChangeSchema = z.object({
  path: z.string(),
  action: z.enum(["create", "replace", "delete"]),
  status: z.enum(["applied", "rejected", "failed"]),
  safety: sourceFileSafetyResultSchema,
  message: z.string(),
  nodeId: z.string().optional(),
  nodeIds: z.array(z.string()).optional()
});

export const patchOperationDecisionSchema = z.object({
  operationIndex: z.number().int().nonnegative(),
  decision: z.enum(["accepted", "rejected"]),
  reason: z.string().optional()
});

export const patchReviewRecordSchema = z.object({
  proposalArtifactId: z.string(),
  runId: z.string(),
  reviewedAt: z.string(),
  decisions: z.array(patchOperationDecisionSchema),
  results: z.array(z.object({
    operationIndex: z.number().int().nonnegative(),
    status: z.enum(["applied", "rejected", "failed"]),
    message: z.string()
  }))
});

export const researchChatScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project"), projectId: z.string() }),
  z.object({ type: z.literal("flow"), flowId: z.string() }),
  z.object({ type: z.literal("subflow"), flowId: z.string(), subflowId: z.string() }),
  z.object({ type: z.literal("node"), flowId: z.string(), nodeId: z.string() })
]);

export const projectMemoryNoteStatusSchema = z.enum(["active", "stale", "archived"]);
export const projectMemoryNoteSchema = z.object({
  id: z.string(),
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(4_000),
  scope: researchChatScopeSchema,
  status: projectMemoryNoteStatusSchema.default("active"),
  pinned: z.boolean().default(false),
  originChatId: z.string().optional(),
  sourceMessageIds: z.array(z.string()).default([]),
  artifactIds: z.array(z.string()).default([]),
  filePaths: z.array(z.string()).default([]),
  revision: z.number().int().positive().default(1),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const researchMessageNodeReferenceSchema = z.object({
  flowId: z.string(),
  nodeId: z.string()
});

// Provider JSON commonly uses an empty string as a placeholder for an
// optional relationship. Persisted graph IDs never use that representation:
// an omitted reference means the node belongs to the root flow (or has no
// parent/group/module binding). Normalize at the shared contract boundary so
// validation and application cannot disagree about the same operation.
const optionalGraphReferenceIdSchema = z.preprocess(
  (value) => typeof value === "string" && !value.trim() ? undefined : value,
  z.string().trim().min(1).optional()
);

export const researchGraphOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("update-project"),
    patch: z.object({
      name: z.string().optional(),
      description: z.string().optional(),
      stackAssumptions: z.array(z.string()).optional(),
      environmentNotes: z.string().optional()
    })
  }),
  z.object({
    kind: z.literal("update-flow"),
    flowId: z.string(),
    patch: z.object({
      name: z.string().optional(),
      description: z.string().optional(),
      perspective: flowPerspectiveSchema.optional()
    })
  }),
  z.object({
    kind: z.literal("create-flow"),
    flow: flowSchema
  }),
  z.object({
    kind: z.literal("update-node"),
    flowId: z.string(),
    patch: archicodeNodeSchema.partial().extend({
      id: archicodeNodeSchema.shape.id,
      parentId: optionalGraphReferenceIdSchema,
      subflowId: optionalGraphReferenceIdSchema,
      groupId: optionalGraphReferenceIdSchema,
      moduleProfileId: optionalGraphReferenceIdSchema
    }).passthrough()
  }),
  z.object({
    kind: z.literal("update-edge"),
    flowId: z.string(),
    edgeId: z.string(),
    patch: flowEdgeSchema.partial().omit({ id: true }).extend({
      source: optionalGraphReferenceIdSchema,
      target: optionalGraphReferenceIdSchema
    })
  }),
  z.object({
    kind: z.literal("add-note"),
    note: noteSchema.omit({ id: true, createdAt: true })
  }),
  z.object({
    kind: z.literal("resolve-note"),
    noteId: z.string(),
    resolved: z.boolean().default(true)
  }),
  z.object({
    kind: z.literal("delete-note"),
    noteId: z.string()
  }),
  z.object({
    kind: z.literal("create-node"),
    flowId: z.string(),
    node: z.object({
      id: optionalGraphReferenceIdSchema,
      type: archicodeNodeSchema.shape.type.default("feature"),
      title: z.string(),
      description: z.string().default(""),
      stage: nodeStageSchema.default("planned"),
      ignored: z.boolean().default(false),
      flags: z.array(nodeFlagSchema).default(["changed"]),
      locked: z.boolean().default(false),
      visual: nodeVisualSchema,
      position: z.union([archicodeNodeSchema.shape.position, relativeNodePositionHintSchema]).optional(),
      positionHint: relativeNodePositionHintSchema.optional(),
      size: archicodeNodeSchema.shape.size.optional(),
      parentId: optionalGraphReferenceIdSchema,
      subflowId: optionalGraphReferenceIdSchema,
      groupId: optionalGraphReferenceIdSchema,
      techStack: z.array(z.string()).default([]),
      acceptanceCriteria: z.array(z.string()).default([]),
      acceptanceChecks: archicodeNodeSchema.shape.acceptanceChecks.default([]),
      subjectRef: archicodeNodeSchema.shape.subjectRef,
      implementationScope: archicodeNodeSchema.shape.implementationScope,
      moduleProfileMode: nodeModuleProfileModeSchema.optional(),
      moduleProfileId: optionalGraphReferenceIdSchema,
      customProperties: archicodeNodeSchema.shape.customProperties.default({}),
      ruleIds: archicodeNodeSchema.shape.ruleIds,
      attachments: z.array(artifactSchema).default([]),
      todos: archicodeNodeSchema.shape.todos.default([])
    })
  }),
  z.object({
    kind: z.literal("create-edge"),
    flowId: z.string(),
    edge: flowEdgeSchema.partial({ id: true }).extend({ id: optionalGraphReferenceIdSchema })
  }),
  z.object({
    kind: z.literal("create-subflow"),
    flowId: z.string(),
    subflow: flowSubflowSchema.partial({ id: true }).extend({
      id: optionalGraphReferenceIdSchema,
      parentNodeId: optionalGraphReferenceIdSchema,
      parentSubflowId: optionalGraphReferenceIdSchema
    })
  }),
  z.object({
    kind: z.literal("create-group"),
    flowId: z.string(),
    group: flowGroupSchema.partial({ id: true }).extend({ id: optionalGraphReferenceIdSchema })
  }),
  z.object({
    kind: z.literal("update-group"),
    flowId: z.string(),
    groupId: z.string(),
    patch: flowGroupSchema.pick({ name: true, color: true }).partial()
  }),
  z.object({
    kind: z.literal("update-subflow"),
    flowId: z.string(),
    subflowId: z.string(),
    patch: z.object({
      name: z.string().optional()
    })
  }),
  z.object({
    kind: z.literal("link-node-subflow"),
    flowId: z.string(),
    nodeId: z.string(),
    subflowId: z.string().nullable()
  }),
  z.object({
    kind: z.literal("propose-run-profile"),
    profile: runTargetProfileSchema,
    mode: z.enum(["create", "replace"]).default("create"),
    reason: z.string().optional()
  }),
  z.object({
    kind: z.literal("start-agent-run"),
    flowId: z.string(),
    nodeId: z.string().optional(),
    scope: runScopeSchema.optional(),
    providerId: z.string().optional(),
    promptSummary: z.string(),
    command: z.string().optional(),
    cwd: z.string().optional(),
    effort: implementationEffortSelectionSchema.optional(),
    allowShell: z.boolean().default(false),
    reusableApproval: z.boolean().default(false),
    guidance: runGuidanceSchema.optional()
  }),
  z.object({
    kind: z.literal("start-run-profile"),
    flowId: z.string(),
    profileId: z.string(),
    targetId: z.string().optional(),
    providerId: z.string().optional(),
    allowShell: z.boolean().default(false),
    reusableApproval: z.boolean().default(false)
  }),
  z.object({
    kind: z.literal("stop-runtime-service"),
    serviceId: z.string().min(1)
  }),
  z.object({
    kind: z.literal("restart-runtime-service"),
    serviceId: z.string().min(1)
  }),
  z.object({
    kind: z.literal("retry-run"),
    runId: z.string(),
    guidance: runGuidanceSchema.optional()
  }),
  z.object({
    kind: z.literal("start-debugging-run"),
    runId: z.string(),
    guidance: runGuidanceSchema.optional()
  }),
  z.object({
    kind: z.literal("author-acceptance-tests"),
    flowId: z.string(),
    nodeId: z.string().optional()
  }),
  z.object({
    kind: z.literal("run-acceptance-checks"),
    flowId: z.string(),
    nodeId: z.string()
  }),
  z.object({
    kind: z.literal("start-runtime-debug-run"),
    serviceId: z.string(),
    flowId: z.string(),
    providerId: z.string().optional(),
    guidance: runGuidanceSchema.optional()
  }),
  z.object({
    kind: z.literal("start-incident-debug-run"),
    flowId: z.string().optional(),
    providerId: z.string().optional(),
    guidance: runGuidanceSchema.optional()
  }),
  z.object({
    kind: z.literal("delete-node"),
    flowId: z.string(),
    nodeId: z.string()
  }),
  z.object({
    kind: z.literal("delete-edge"),
    flowId: z.string(),
    edgeId: z.string()
  }),
  z.object({
    kind: z.literal("delete-subflow"),
    flowId: z.string(),
    subflowId: z.string()
  }),
  z.object({
    kind: z.literal("delete-group"),
    flowId: z.string(),
    groupId: z.string()
  })
]);

/** Runtime source of truth for every operation accepted by Research review cards. */
export const researchGraphOperationKinds = researchGraphOperationSchema.options.map(
  (operationSchema) => operationSchema.shape.kind.value
) as Array<z.infer<typeof researchGraphOperationSchema>["kind"]>;

export const researchGraphChangeSetSchema = z.object({
  id: z.string(),
  summary: z.string(),
  operations: z.array(researchGraphOperationSchema).default([]),
  createdAt: z.string(),
  reviewedAt: z.string().optional(),
  // Set when a newer proposal in the same session replaced this still-unreviewed
  // card. Implies reviewedAt (the card is no longer actionable) but distinguishes
  // "auto-retired because superseded" from an explicit Apply/Reject.
  supersededAt: z.string().optional()
});

const researchMemoryTextRecordSchema = z.object({
  id: z.string(),
  text: z.string(),
  sourceMessageIds: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string().optional()
});

const researchMemoryTodoSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["open", "awaiting-approval", "doing", "blocked", "done", "cancelled"]).default("open"),
  notes: z.string().optional(),
  sourceMessageIds: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string().optional()
});

const researchMemoryQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  status: z.enum(["open", "answered", "resolved"]).default("open"),
  answer: z.string().optional(),
  sourceMessageIds: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string().optional()
});

const researchMemoryLinkSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string().optional(),
  note: z.string().optional(),
  sourceMessageIds: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string().optional()
});

const researchMemoryOptionalStringSchema = z.preprocess(
  (value) => value === null ? undefined : value,
  z.string().optional()
);

const researchMemoryGraphRefSchema = z.object({
  id: z.string(),
  kind: z.enum(["project", "flow", "subflow", "node"]),
  flowId: researchMemoryOptionalStringSchema,
  subflowId: researchMemoryOptionalStringSchema,
  nodeId: researchMemoryOptionalStringSchema,
  title: researchMemoryOptionalStringSchema,
  note: researchMemoryOptionalStringSchema,
  sourceMessageIds: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string().optional()
});

const researchMemoryRunRefSchema = z.object({
  id: z.string(),
  runId: z.string(),
  title: z.string().optional(),
  status: z.string().optional(),
  note: z.string().optional(),
  sourceMessageIds: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string().optional()
});

const researchMemoryFileRefSchema = z.object({
  id: z.string(),
  path: z.string(),
  title: z.string().optional(),
  note: z.string().optional(),
  sourceMessageIds: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string().optional()
});

const researchMemoryArtifactRefSchema = z.object({
  id: z.string(),
  artifactId: z.string(),
  type: z.string().optional(),
  title: z.string().optional(),
  path: z.string().optional(),
  note: z.string().optional(),
  sourceMessageIds: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string().optional()
});

const researchMemoryImageRefSchema = z.object({
  id: z.string(),
  artifactId: z.string(),
  title: z.string().optional(),
  mediaType: z.string().optional(),
  visualSummary: z.string().optional(),
  extractedText: z.string().optional(),
  relevantFindings: z.array(z.string()).default([]),
  sourceMessageIds: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string().optional()
});

export const researchMemorySchema = z.object({
  summary: z.string().default(""),
  decisions: z.array(researchMemoryTextRecordSchema).default([]),
  todos: z.array(researchMemoryTodoSchema).default([]),
  openQuestions: z.array(researchMemoryQuestionSchema).default([]),
  links: z.array(researchMemoryLinkSchema).default([]),
  facts: z.array(researchMemoryTextRecordSchema).default([]),
  assumptions: z.array(researchMemoryTextRecordSchema).default([]),
  graphRefs: z.array(researchMemoryGraphRefSchema).default([]),
  runRefs: z.array(researchMemoryRunRefSchema).default([]),
  fileRefs: z.array(researchMemoryFileRefSchema).default([]),
  artifactRefs: z.array(researchMemoryArtifactRefSchema).default([]),
  imageRefs: z.array(researchMemoryImageRefSchema).default([]),
  debugFindings: z.array(researchMemoryTextRecordSchema).default([]),
  lastCompactedMessageId: z.string().optional(),
  lastUpdateError: z.string().optional(),
  updatedAt: z.string().default("")
}).default({
  summary: "",
  decisions: [],
  todos: [],
  openQuestions: [],
  links: [],
  facts: [],
  assumptions: [],
  graphRefs: [],
  runRefs: [],
  fileRefs: [],
  artifactRefs: [],
  imageRefs: [],
  debugFindings: [],
  updatedAt: ""
});

const researchOrchestrationTodoSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["open", "awaiting-approval", "doing", "blocked", "done", "cancelled"]).default("open"),
  notes: z.string().optional(),
  changeSetId: z.string().optional(),
  messageId: z.string().optional(),
  operationIndexes: z.array(z.number().int().nonnegative()).default([]),
  createdAt: z.string(),
  updatedAt: z.string().optional()
});

export const researchGoalStepStatusSchema = z.enum([
  "open",
  "doing",
  "awaiting-approval",
  "waiting",
  "blocked",
  "done",
  "cancelled"
]);

const researchGoalWaitRefSchema = z.object({
  kind: z.enum(["approval", "subagent", "run", "runtime"]),
  id: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1).optional()
});

const researchGoalStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: researchGoalStepStatusSchema.default("open"),
  notes: z.string().optional(),
  evidence: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string().optional()
});

export const researchGoalSchema = z.object({
  id: z.string(),
  objective: z.string(),
  successCriteria: z.array(z.string()).default([]),
  status: z.enum(["active", "awaiting-approval", "waiting", "blocked", "completed", "cancelled"]).default("active"),
  steps: z.array(researchGoalStepSchema).default([]),
  currentStepId: z.string().optional(),
  checkpointSummary: z.string().optional(),
  completionEvidence: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  waitingFor: z.array(researchGoalWaitRefSchema).default([]),
  continuationCount: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional()
});

export const researchGoalStartInputSchema = z.object({
  objective: z.string().trim().min(1),
  successCriteria: z.array(z.string().trim().min(1)).min(1),
  steps: z.array(z.object({
    id: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1)
  })).min(1),
  summary: z.string().trim().min(1).optional()
});

export const researchGoalCheckpointInputSchema = z.object({
  status: z.enum(["continue", "awaiting-approval", "waiting", "blocked", "completed", "cancelled"]),
  summary: z.string().trim().min(1),
  currentStepId: z.string().trim().min(1).nullable().optional(),
  stepUpdates: z.array(z.object({
    id: z.string().trim().min(1),
    status: researchGoalStepStatusSchema,
    notes: z.string().trim().min(1).optional(),
    evidence: z.array(z.string().trim().min(1)).default([])
  })).default([]),
  evidence: z.array(z.string().trim().min(1)).default([]),
  blockers: z.array(z.string().trim().min(1)).default([]),
  waitingFor: z.array(researchGoalWaitRefSchema).default([])
});

export const researchOrchestrationSchema = z.object({
  goal: researchGoalSchema.optional(),
  todos: z.array(researchOrchestrationTodoSchema).default([]),
  updatedAt: z.string().default("")
}).default({
  todos: [],
  updatedAt: ""
});

const researchMemoryDeltaTextRecordSchema = researchMemoryTextRecordSchema.omit({ id: true, createdAt: true }).extend({
  id: z.string().optional(),
  createdAt: z.string().optional()
});

export const researchMemoryDeltaSchema = z.object({
  summary: z.string().optional(),
  supersedesFactIds: z.array(z.string().trim().min(1)).default([]),
  decisions: z.array(researchMemoryDeltaTextRecordSchema).default([]),
  todos: z.array(researchMemoryTodoSchema.omit({ id: true, createdAt: true }).extend({
    id: z.string().optional(),
    createdAt: z.string().optional()
  })).default([]),
  openQuestions: z.array(researchMemoryQuestionSchema.omit({ id: true, createdAt: true }).extend({
    id: z.string().optional(),
    createdAt: z.string().optional()
  })).default([]),
  links: z.array(researchMemoryLinkSchema.omit({ id: true, createdAt: true }).extend({
    id: z.string().optional(),
    createdAt: z.string().optional()
  })).default([]),
  facts: z.array(researchMemoryDeltaTextRecordSchema).default([]),
  assumptions: z.array(researchMemoryDeltaTextRecordSchema).default([]),
  graphRefs: z.array(researchMemoryGraphRefSchema.omit({ id: true, createdAt: true }).extend({
    id: z.string().optional(),
    createdAt: z.string().optional()
  })).default([]),
  runRefs: z.array(researchMemoryRunRefSchema.omit({ id: true, createdAt: true }).extend({
    id: z.string().optional(),
    createdAt: z.string().optional()
  })).default([]),
  fileRefs: z.array(researchMemoryFileRefSchema.omit({ id: true, createdAt: true }).extend({
    id: z.string().optional(),
    createdAt: z.string().optional()
  })).default([]),
  artifactRefs: z.array(researchMemoryArtifactRefSchema.omit({ id: true, createdAt: true }).extend({
    id: z.string().optional(),
    createdAt: z.string().optional()
  })).default([]),
  imageRefs: z.array(researchMemoryImageRefSchema.omit({ id: true, createdAt: true }).extend({
    id: z.string().optional(),
    createdAt: z.string().optional()
  })).default([]),
  debugFindings: z.array(researchMemoryDeltaTextRecordSchema).default([])
});

export const researchCanvasViewportActionSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("fit"),
    padding: z.number().min(0).max(1).default(0.24),
    maxZoom: z.number().min(0.035).max(1.35).default(1.08)
  }),
  z.object({
    mode: z.literal("center"),
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().min(0.035).max(1.35).optional()
  }),
  z.object({
    mode: z.literal("pan"),
    dx: z.number().finite(),
    dy: z.number().finite()
  }),
  z.object({
    mode: z.literal("zoom-to"),
    zoom: z.number().min(0.035).max(1.35)
  }),
  z.object({
    mode: z.literal("zoom-by"),
    factor: z.number().min(0.1).max(10)
  }),
  z.object({ mode: z.literal("preserve") })
]);

export const researchCanvasActionSchema = z.object({
  flowId: z.string().trim().min(1),
  subflowId: z.string().trim().min(1).nullable().optional(),
  nodeIds: z.array(z.string().trim().min(1)).default([]),
  groupIds: z.array(z.string().trim().min(1)).default([]),
  selection: z.enum(["replace", "clear", "preserve"]).default("replace"),
  viewport: researchCanvasViewportActionSchema.default({ mode: "fit", padding: 0.24, maxZoom: 1.08 })
});

export const researchChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  createdAt: z.string(),
  attachmentIds: z.array(z.string()).default([]),
  webUsed: z.boolean().default(false),
  mcpToolCalls: z.array(z.object({
    serverId: z.string(),
    serverLabel: z.string().optional(),
    toolName: z.string(),
    argumentsJson: z.string().optional(),
    status: z.enum(["succeeded", "failed", "approval-required"]),
    resultSummary: z.string().optional(),
    error: z.string().optional(),
    createdAt: z.string()
  })).default([]),
  mcpApprovalRequest: z.object({
    serverIds: z.array(z.string()),
    serverLabels: z.array(z.string()),
    toolName: z.string(),
    providerToolName: z.string(),
    argumentsJson: z.string().optional(),
    originalContent: z.string(),
    filePaths: z.array(z.string()).default([]),
    // Approval cards can be raised while the host is privately resuming a
    // durable goal. Preserve that provenance so the approval decision resumes
    // the private turn instead of presenting its host prompt as user speech.
    internalContinuation: z.boolean().optional(),
    // Persisted provider conversation state so an approved tool can be resumed
    // without re-generating the assistant work that preceded the approval. When
    // absent (or stale/oversized), the turn falls back to replay.
    providerContinuation: z.object({
      transport: z.enum(["anthropic", "openai-chat", "openai-responses", "codex-local", "claude-local", "opencode-local", "antigravity-local", "grok-local", "kimi-local"]),
      messages: z.array(z.unknown()).optional(),
      previousResponseId: z.string().optional(),
      pendingToolCall: z.object({
        id: z.string(),
        providerToolName: z.string(),
        argumentsJson: z.string()
      })
    }).optional()
  }).optional(),
  canvasAction: researchCanvasActionSchema.optional(),
  changeSet: researchGraphChangeSetSchema.optional(),
  subagentRuns: z.array(subagentRunSchema).default([]),
  // Aggregated LLM cost/usage for this assistant turn, including its inner tool
  // loop. Subagent costs are carried on each subagentRun.usage, not here.
  usage: llmUsageSchema.optional(),
  // Host-counted work tally for this turn (model generations, host-forced answer
  // re-rolls, transport retries). Diagnostics only: persisted for chat exports and
  // debugging, never rendered in the chat UI. Independent of provider token usage.
  turnDiagnostics: z.object({
    rounds: z.number().int().nonnegative(),
    rerolls: z.number().int().nonnegative(),
    transientRetries: z.number().int().nonnegative()
  }).optional(),
  error: z.string().optional()
});

export const researchChatSessionSchema = z.object({
  id: z.string(),
  projectRoot: z.string(),
  scope: researchChatScopeSchema,
  title: z.string(),
  summary: z.string().default(""),
  memory: researchMemorySchema,
  orchestration: researchOrchestrationSchema,
  autoApproveGraphChanges: researchAutoApproveGraphChangesSchema,
  archived: z.boolean().default(false),
  messages: z.array(researchChatMessageSchema).default([]),
  /** Provider used for the most recent turn; the active provider may replace it on the next turn. */
  providerId: z.string().optional(),
  /** Per-chat model selection. Null explicitly keeps using the provider's configured default. */
  modelId: z.string().trim().min(1).nullable().optional(),
  webEnabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const researchChatResponseSchema = z.object({
  answer: z.string(),
  summary: z.string().optional(),
  canvasAction: researchCanvasActionSchema.optional(),
  changeSet: researchGraphChangeSetSchema.omit({ id: true, createdAt: true }).optional()
});

export const researchGraphChangeDecisionSchema = z.object({
  operationIndex: z.number().int().nonnegative(),
  decision: z.enum(["accepted", "rejected"]),
  reason: z.string().optional()
});

export const researchGraphChangeResultSchema = z.object({
  operationIndex: z.number().int().nonnegative(),
  status: z.enum(["applied", "rejected", "failed"]),
  message: z.string()
});

export type NodeStage = z.infer<typeof nodeStageSchema>;
export type NodeFlag = z.infer<typeof nodeFlagSchema>;
export type AcceptanceCheck = z.infer<typeof acceptanceCheckSchema>;
export type AcceptanceCheckStatus = z.infer<typeof acceptanceCheckStatusSchema>;
export type NodeModuleProfileMode = z.infer<typeof nodeModuleProfileModeSchema>;
export type ImplementationScopeClaim = z.infer<typeof implementationScopeClaimSchema>;
export type ImplementationScope = z.infer<typeof implementationScopeSchema>;
export type GraphSubjectRef = z.infer<typeof graphSubjectRefSchema>;
export type GraphChangeRetention = z.infer<typeof graphChangeRetentionSchema>;
export type ArchicodeNode = z.infer<typeof archicodeNodeSchema>;
export type NodeRule = z.infer<typeof nodeRuleSchema>;
export type ArchitectureIntentKind = z.infer<typeof architectureIntentKindSchema>;
export type ArchitecturePolicyConstraint = z.infer<typeof architecturePolicyConstraintSchema>;
export type ArchitecturePolicyConstraintKind = z.infer<typeof architecturePolicyConstraintKindSchema>;
export type ArchitecturePolicyNodeScope = z.infer<typeof architecturePolicyNodeScopeSchema>;
export type ArchitecturePolicyMetadataField = z.infer<typeof architecturePolicyMetadataFieldSchema>;
export type ArchitecturePolicyFileNameStyle = z.infer<typeof architecturePolicyFileNameStyleSchema>;
export type ArchitecturePolicySeverity = z.infer<typeof architecturePolicySeveritySchema>;
export type ArchitecturePolicyEnforcement = z.infer<typeof architecturePolicyEnforcementSchema>;
export type ArchitecturePolicyViolation = z.infer<typeof architecturePolicyViolationSchema>;
export type ArchitecturePolicyEvaluation = z.infer<typeof architecturePolicyEvaluationSchema>;
export type FlowEdge = z.infer<typeof flowEdgeSchema>;
export type GraphEdgeEvidence = z.infer<typeof graphEdgeEvidenceSchema>;
export type FlowSubflow = z.infer<typeof flowSubflowSchema>;
export type FlowGroup = z.infer<typeof flowGroupSchema>;
export type ArchitecturePerspectiveKind = z.infer<typeof architecturePerspectiveKindSchema>;
export type FlowPerspective = z.infer<typeof flowPerspectiveSchema>;
export type Flow = z.infer<typeof flowSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectBundle = z.infer<typeof projectBundleSchema>;
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export type ContextBuilderSettings = z.infer<typeof contextBuilderSettingsSchema>;
export type SemanticIndexSettings = z.infer<typeof semanticIndexSettingsSchema>;
export type SpeechModelId = z.infer<typeof speechModelIdSchema>;
export type TtsModelId = z.infer<typeof ttsModelIdSchema>;
export type TtsVoiceId = z.infer<typeof ttsVoiceIdSchema>;
export type SpeechSettings = z.infer<typeof speechSettingsSchema>;
export type TtsSettings = z.infer<typeof ttsSettingsSchema>;
export type RunTargetProfile = z.infer<typeof runTargetProfileSchema>;
export type RuntimeService = z.infer<typeof runtimeServiceSchema>;
export type RunEvidenceKind = z.infer<typeof runEvidenceKindSchema>;
export type RunGuidance = z.infer<typeof runGuidanceSchema>;
export type RunScope = z.infer<typeof runScopeSchema>;
export type RunEffort = z.infer<typeof runEffortSchema>;
export type RunContextSummary = z.infer<typeof runContextSummarySchema>;
export type RunMemoryCard = z.infer<typeof runMemoryCardSchema>;
export type RunImplementationCheckpoint = z.infer<typeof runImplementationCheckpointSchema>;
export type RunImplementationState = z.infer<typeof runImplementationStateSchema>;
export type RunImplementationTask = z.infer<typeof runImplementationTaskSchema>;
export type IssuePriority = z.infer<typeof issuePrioritySchema>;
export type NoteCategory = z.infer<typeof noteCategorySchema>;
export type LlmPhase = z.infer<typeof llmPhaseSchema>;
export type ReasoningMode = z.infer<typeof reasoningModeSchema>;
export type PhaseModelPolicy = z.infer<typeof phaseModelPolicySchema>;
export type SubagentModelProfile = z.infer<typeof subagentModelProfileSchema>;
export type SubagentModelPolicies = z.infer<typeof subagentModelPoliciesSchema>;
export type ModelCapabilityProfile = z.infer<typeof modelCapabilityProfileSchema>;
export type Note = z.infer<typeof noteSchema>;
export type DebugIncident = z.infer<typeof debugIncidentSchema>;
export type Run = z.infer<typeof runSchema>;
export type RunPhase = z.infer<typeof runPhaseSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type ContextMemoryRecord = z.infer<typeof contextMemoryRecordSchema>;
export type ContextManifest = z.infer<typeof contextManifestSchema>;
export type GraphChangeRecord = z.infer<typeof graphChangeRecordSchema>;
export type ShellPolicy = z.infer<typeof shellPolicySchema>;
export type FilesystemPolicy = z.infer<typeof filesystemPolicySchema>;
export type FilesystemSecurity = z.infer<typeof filesystemSecuritySchema>;
export type CanvasBackground = z.infer<typeof canvasBackgroundSchema>;
export type CanvasEdgeStyle = z.infer<typeof canvasEdgeStyleSchema>;
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export type WebSearchSettings = z.infer<typeof webSearchSettingsSchema>;
export type AgentToolSettings = z.infer<typeof agentToolSettingsSchema>;
export type ProjectSkillSettings = z.infer<typeof projectSkillSettingsSchema>;
export type McpServer = z.infer<typeof mcpServerSchema>;
export type McpSettings = z.infer<typeof mcpSettingsSchema>;
export type ExternalMcpHostSettings = z.infer<typeof externalMcpHostSettingsSchema>;
export type LlmPatchProposal = z.infer<typeof llmPatchProposalSchema>;
export type SourceFileProposal = Extract<LlmPatchProposal["operations"][number], { kind: "propose-source-file" }>;
export type SourceFileSafetyResult = z.infer<typeof sourceFileSafetyResultSchema>;
export type AppliedSourceFileChange = z.infer<typeof appliedSourceFileChangeSchema>;
export type PatchOperationDecision = z.infer<typeof patchOperationDecisionSchema>;
export type PatchReviewRecord = z.infer<typeof patchReviewRecordSchema>;
export type ResearchChatScope = z.infer<typeof researchChatScopeSchema>;
export type ProjectMemoryNote = z.infer<typeof projectMemoryNoteSchema>;
export type ProjectMemoryNoteStatus = z.infer<typeof projectMemoryNoteStatusSchema>;

export type ResearchMessageNodeReference = z.infer<typeof researchMessageNodeReferenceSchema>;
export type ResearchCanvasViewportAction = z.infer<typeof researchCanvasViewportActionSchema>;
export type ResearchCanvasAction = z.infer<typeof researchCanvasActionSchema>;
export type ResearchGraphChangeSet = z.infer<typeof researchGraphChangeSetSchema>;
export type ResearchGraphOperation = z.infer<typeof researchGraphOperationSchema>;
export type ResearchMemory = z.infer<typeof researchMemorySchema>;
export type ResearchMemoryDelta = z.infer<typeof researchMemoryDeltaSchema>;
export type ResearchGoal = z.infer<typeof researchGoalSchema>;
export type ResearchGoalStartInput = z.input<typeof researchGoalStartInputSchema>;
export type ResearchGoalCheckpointInput = z.input<typeof researchGoalCheckpointInputSchema>;
export type ResearchOrchestration = z.infer<typeof researchOrchestrationSchema>;
export type ResearchChatMessage = z.infer<typeof researchChatMessageSchema>;
export type ResearchChatSession = z.infer<typeof researchChatSessionSchema>;
export type ResearchChatResponse = z.infer<typeof researchChatResponseSchema>;
export type ResearchGraphChangeDecision = z.infer<typeof researchGraphChangeDecisionSchema>;
export type ResearchGraphChangeResult = z.infer<typeof researchGraphChangeResultSchema>;

export type NodePatch = Partial<Omit<ArchicodeNode, "id">> & { id: string; forceUnlockRevision?: boolean };

const nodePositionSchema = z.object({ x: z.number(), y: z.number() });
const nodeSizeSchema = z.object({ width: z.number(), height: z.number() });

export const presentationNodeMutationSchema = z.discriminatedUnion("field", [
  z.object({
    nodeId: z.string().trim().min(1),
    field: z.literal("position"),
    expected: nodePositionSchema,
    value: nodePositionSchema
  }),
  z.object({
    nodeId: z.string().trim().min(1),
    field: z.literal("size"),
    expected: nodeSizeSchema.nullable(),
    value: nodeSizeSchema.nullable()
  }),
  z.object({
    nodeId: z.string().trim().min(1),
    field: z.literal("visual"),
    expected: nodeVisualSchema,
    value: nodeVisualSchema
  })
]);

export const presentationPatchRequestSchema = z.object({
  flowId: z.string().trim().min(1),
  mutations: z.array(presentationNodeMutationSchema).min(1).max(500)
}).superRefine((request, context) => {
  const targets = new Set<string>();
  request.mutations.forEach((mutation, index) => {
    const target = `${mutation.nodeId}:${mutation.field}`;
    if (targets.has(target)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mutations", index],
        message: `Duplicate presentation mutation target ${target}.`
      });
    }
    targets.add(target);
  });
});

export type PresentationNodeMutation = z.infer<typeof presentationNodeMutationSchema>;
export type PresentationPatchRequest = z.infer<typeof presentationPatchRequestSchema>;
export type PresentationPatchResult = {
  status: "applied" | "conflict";
  bundle: ProjectBundle;
  message?: string;
};

export function isNoteActiveForModelContext(note: Pick<Note, "pinned" | "resolved">): boolean {
  return note.pinned || !note.resolved;
}

export function isProductionApproved(node: Pick<ArchicodeNode, "stage" | "flags" | "locked">): boolean {
  return node.locked || node.stage === "draft-approved-production" || node.flags.includes("user-approved");
}

// A node's build-verified dirty-flag clearing is gated on its acceptance checks:
// a node with no checks behaves as before (nothing to satisfy), but once checks
// exist every one must be "passing" before a verified build may clear the node.
export function nodeAcceptanceChecksSatisfied(node: Pick<ArchicodeNode, "acceptanceChecks">): boolean {
  return node.acceptanceChecks.length === 0 || node.acceptanceChecks.every((check) => check.status === "passing");
}

function isApprovalStage(stage: ArchicodeNode["stage"] | undefined): boolean {
  return stage === "plan-approved" || stage === "draft-approved-production";
}

function patchHasMeaningfulUserEdit(changes: Partial<Omit<ArchicodeNode, "id">>): boolean {
  const visualOnlyFields = new Set(["visual", "position", "size", "ignored", "groupId", "updatedAt"]);
  return Object.keys(changes).some((key) => !visualOnlyFields.has(key));
}

export function applyNodePatch(node: ArchicodeNode, patch: NodePatch, actor: "user" | "llm"): ArchicodeNode {
  if (node.id !== patch.id) {
    throw new Error(`Patch ${patch.id} does not match node ${node.id}.`);
  }

  if (actor === "llm") {
    if (patch.forceUnlockRevision) {
      throw new Error("LLM patches cannot bypass user approval or unlock approved nodes.");
    }
    if (Object.prototype.hasOwnProperty.call(patch, "ignored")) {
      throw new Error("LLM patches cannot change whether nodes are ignored.");
    }
    if (isApprovalStage(patch.stage)) {
      throw new Error("LLM patches cannot approve nodes or move nodes into an approved stage.");
    }
    if (patch.flags?.includes("user-approved")) {
      throw new Error("LLM patches cannot add the user-approved flag.");
    }
    if (patch.locked === true) {
      throw new Error("LLM patches cannot lock nodes as approved.");
    }
  }

  if (actor === "llm" && isProductionApproved(node) && !patch.forceUnlockRevision) {
    throw new Error(`Node "${node.title}" is approved and locked. Create a revision before changing it.`);
  }
  if (actor === "llm" && node.ignored) {
    throw new Error(`Node "${node.title}" is ignored and outside the agent working set.`);
  }

  const { forceUnlockRevision: _forceUnlockRevision, id: _id, ...changes } = patch;
  const next = {
    ...node,
    ...changes,
    id: node.id,
    updatedAt: new Date().toISOString()
  };

  if (actor === "llm" && Object.prototype.hasOwnProperty.call(changes, "flags")) {
    const flags = new Set(next.flags);
    if (node.flags.includes("changed")) flags.add("changed");
    else flags.delete("changed");
    next.flags = [...flags];
  }

  if (actor === "user" && patchHasMeaningfulUserEdit(changes)) {
    const flags = new Set(next.flags);
    if (next.stage === "draft-approved-production") {
      flags.delete("changed");
    } else {
      flags.add("changed");
    }
    next.flags = [...flags];
  }

  if (next.stage === "draft-approved-production" && !next.flags.includes("user-approved")) {
    next.flags = [...next.flags, "user-approved"];
  }

  next.locked = isProductionApproved(next);
  return archicodeNodeSchema.parse(next);
}

export function estimateContextSize(value: unknown): number {
  return JSON.stringify(value).length;
}
