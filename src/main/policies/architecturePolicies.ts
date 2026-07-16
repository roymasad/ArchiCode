import { createHash } from "node:crypto";
import path from "node:path";
import {
  architecturePolicyEvaluationSchema,
  type ArchitecturePolicyEvaluation,
  type ArchitecturePolicyViolation,
  type NodeRule,
  type ProjectBundle
} from "../../shared/schema";
import { buildContentInventory } from "../importer/inventory";
import { buildFileDependencyGraph } from "../importer/fileGraph";
import { parseFiles } from "../importer/parsers";
import { addHighConfidenceRuntimeEdges } from "../importer/runtimeEdges";
import { scanRepository } from "../importer/scanner";
import type { FileEdge, ParsedFile, ScannedFile } from "../importer/types";
import { projectStatePath, readJson, writeJson } from "../storage/persistence";

const POLICY_EVALUATION_FILE = "architecture-policy-evaluation.json";
const POLICY_ANALYZER_VERSION = 2;
const RUNTIME_RELATION_KINDS = new Set(["ipc", "http", "hosts", "runtime-load"]);
const GRAPH_POLICY_KINDS = new Set(["required-node-metadata", "node-relationship", "no-orphan-nodes"]);

export type ArchitecturePolicyEvaluationResult = {
  evaluation: ArchitecturePolicyEvaluation;
  changed: boolean;
  baselineAvailable: boolean;
  newViolationIds: string[];
};

export type ArchitecturePolicyFacts = {
  files?: ScannedFile[];
  parsedFiles?: ParsedFile[];
};

export function blockingArchitecturePolicyViolationsSinceBaseline(
  evaluation: ArchitecturePolicyEvaluation,
  baselineViolationIds: readonly string[]
): ArchitecturePolicyViolation[] {
  const baseline = new Set(baselineViolationIds);
  return evaluation.violations.filter((violation) =>
    !baseline.has(violation.id) && violation.enforcement === "enforced" && violation.severity === "error"
  );
}

export function blockingNewArchitecturePolicyViolations(result: ArchitecturePolicyEvaluationResult): ArchitecturePolicyViolation[] {
  if (!result.baselineAvailable) return [];
  const newViolationIds = new Set(result.newViolationIds);
  return result.evaluation.violations.filter((violation) =>
    newViolationIds.has(violation.id) && violation.enforcement === "enforced" && violation.severity === "error"
  );
}

function normalizedPath(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "").replace(/^\//, "");
}

function normalizedGlob(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\//, "");
  return normalized.endsWith("/") ? `${normalized}**` : normalized;
}

function globRegExp(glob: string): RegExp {
  const value = normalizedGlob(glob);
  let source = "^";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "*") {
      const isDouble = value[index + 1] === "*";
      if (isDouble) {
        const followedBySlash = value[index + 2] === "/";
        source += followedBySlash ? "(?:.*/)?" : ".*";
        index += followedBySlash ? 2 : 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += /[.+^${}()|[\]\\]/.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${source}$`);
}

export function matchesArchitecturePathGlob(filePath: string, glob: string): boolean {
  return globRegExp(glob).test(normalizedPath(filePath));
}

function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  return globs.some((glob) => matchesArchitecturePathGlob(filePath, glob));
}

function activePolicyRules(bundle: ProjectBundle): NodeRule[] {
  return (bundle.project.settings.nodeRules ?? []).filter((rule) => (rule.status ?? "active") === "active" && Boolean(rule.constraint));
}

function architecturePolicyFingerprint(bundle: ProjectBundle): string {
  const definitions = activePolicyRules(bundle)
    .map((rule) => ({
      id: rule.id,
      title: rule.title,
      body: rule.body,
      kind: rule.kind ?? "policy",
      status: rule.status ?? "active",
      severity: rule.severity ?? "warning",
      enforcement: rule.enforcement ?? "advisory",
      constraint: rule.constraint
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(JSON.stringify(definitions)).digest("hex");
}

export function architecturePolicyBaselineViolationIds(bundle: ProjectBundle): string[] | undefined {
  const evaluation = bundle.policyEvaluation;
  if (!evaluation || evaluation.policyFingerprint !== architecturePolicyFingerprint(bundle)) return undefined;
  return evaluation.violations.map((violation) => violation.id);
}

export function hasArchitecturePolicies(bundle: ProjectBundle): boolean {
  return activePolicyRules(bundle).length > 0;
}

export function hasEnforcedArchitecturePolicies(bundle: ProjectBundle): boolean {
  return activePolicyRules(bundle).some((rule) => rule.enforcement === "enforced" && rule.severity === "error");
}

type ArchitectureAssignment = { flowId: string; nodeId: string; score: number; flowPriority: number };

function assignmentForPath(bundle: ProjectBundle, filePath: string): ArchitectureAssignment | undefined {
  const normalizedFile = normalizedPath(filePath);
  const candidates: ArchitectureAssignment[] = [];
  for (const flow of bundle.flows) {
    if (flow.ignored) continue;
    const flowPriority = flow.id === bundle.project.activeFlowId ? 1 : 0;
    for (const node of flow.nodes) {
      if (node.ignored) continue;
      for (const claim of node.implementationScope?.claims ?? []) {
        const claimPath = normalizedPath(claim.path).replace(/\/$/, "");
        const matches = claim.kind === "directory"
          ? claimPath === "." || normalizedFile === claimPath || normalizedFile.startsWith(`${claimPath}/`)
          : normalizedFile === claimPath;
        if (!matches) continue;
        candidates.push({
          flowId: flow.id,
          nodeId: node.id,
          score: claim.kind === "directory" ? claimPath.length : 100000 + claimPath.length,
          flowPriority
        });
      }
    }
  }
  return candidates.sort((left, right) =>
    right.score - left.score || right.flowPriority - left.flowPriority || left.flowId.localeCompare(right.flowId) || left.nodeId.localeCompare(right.nodeId)
  )[0];
}

function stableViolationId(policyId: string, sourcePath: string, targetPath = "", discriminator = ""): string {
  const suffix = discriminator ? `\0${discriminator}` : "";
  return `policy-violation-${createHash("sha1").update(`${policyId}\0${normalizedPath(sourcePath)}\0${normalizedPath(targetPath)}${suffix}`).digest("hex").slice(0, 20)}`;
}

function isRuntimeRelationship(edge: FileEdge): boolean {
  return edge.relationKinds?.some((kind) => RUNTIME_RELATION_KINDS.has(kind)) ?? false;
}

type PolicyEndpoint = ArchitecturePolicyViolation["source"];
type NodeLocation = { flow: ProjectBundle["flows"][number]; node: ProjectBundle["flows"][number]["nodes"][number] };

function fileEndpoint(bundle: ProjectBundle, filePath: string, evidence?: { line?: number; specifier?: string }): PolicyEndpoint {
  const assignment = assignmentForPath(bundle, filePath);
  return {
    entityKind: "file",
    path: normalizedPath(filePath),
    ...(evidence?.line ? { line: evidence.line } : {}),
    ...(evidence?.specifier ? { fact: evidence.specifier } : {}),
    ...(assignment ? { flowId: assignment.flowId, nodeId: assignment.nodeId } : {})
  };
}

function nodeEndpoint(location: NodeLocation, fact?: string): PolicyEndpoint {
  return {
    entityKind: "node",
    path: `${location.flow.name} / ${location.node.title}`,
    flowId: location.flow.id,
    nodeId: location.node.id,
    ...(fact ? { fact } : {})
  };
}

function allNodeLocations(bundle: ProjectBundle): NodeLocation[] {
  return bundle.flows.flatMap((flow) => flow.ignored ? [] : flow.nodes.filter((node) => !node.ignored).map((node) => ({ flow, node })));
}

function scopedNodeLocations(bundle: ProjectBundle, rule: NodeRule, scope: "attached" | "flow" | "subflow" | "project"): NodeLocation[] {
  const all = allNodeLocations(bundle);
  if (scope === "project") return all;
  const attached = all.filter(({ node }) => node.ruleIds?.includes(rule.id));
  if (scope === "attached") return attached;
  if (!attached.length) return [];
  if (scope === "flow") {
    const flowIds = new Set(attached.map(({ flow }) => flow.id));
    return all.filter(({ flow }) => flowIds.has(flow.id));
  }
  const subflowKeys = new Set(attached.map(({ flow, node }) => `${flow.id}\0${node.subflowId ?? "root"}`));
  return all.filter(({ flow, node }) => subflowKeys.has(`${flow.id}\0${node.subflowId ?? "root"}`));
}

function repositoryFilePaths(fileEdges: FileEdge[], facts: ArchitecturePolicyFacts): string[] {
  return [...new Set([
    ...(facts.files ?? []).map((file) => normalizedPath(file.relPath)),
    ...(facts.parsedFiles ?? []).map((file) => normalizedPath(file.relPath)),
    ...fileEdges.flatMap((edge) => [normalizedPath(edge.from), normalizedPath(edge.to)])
  ])].sort((left, right) => left.localeCompare(right));
}

function dependencyEdges(fileEdges: FileEdge[], includeRuntime: boolean): FileEdge[] {
  return includeRuntime ? fileEdges : fileEdges.filter((edge) => !isRuntimeRelationship(edge));
}

function stronglyConnectedFileComponents(edges: FileEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let index = 0;

  const visit = (node: string) => {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of adjacency.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(target)!));
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    while (stack.length) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    if (component.length > 1) components.push(component.sort((left, right) => left.localeCompare(right)));
  };

  for (const node of new Set(edges.flatMap((edge) => [edge.from, edge.to]))) {
    if (!indices.has(node)) visit(node);
  }
  return components.sort((left, right) => left[0]!.localeCompare(right[0]!));
}

function fileNameMatchesStyle(filePath: string, style: "kebab-case" | "camelCase" | "PascalCase" | "snake_case"): boolean {
  const name = path.posix.basename(filePath, path.posix.extname(filePath));
  const patterns = {
    "kebab-case": /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    camelCase: /^[a-z][A-Za-z0-9]*$/,
    PascalCase: /^[A-Z][A-Za-z0-9]*$/,
    snake_case: /^[a-z0-9]+(?:_[a-z0-9]+)*$/
  } as const;
  return patterns[style].test(name);
}

function comparableFileStem(filePath: string): string {
  const withoutExtension = path.posix.basename(filePath, path.posix.extname(filePath));
  return withoutExtension.replace(/\.(?:test|spec|stories|story|docs?|documentation)$/i, "").toLocaleLowerCase();
}

function nodeHasDocumentation(bundle: ProjectBundle, nodeId: string): boolean {
  const artifacts = bundle.artifacts.filter((artifact) => artifact.nodeId === nodeId);
  return artifacts.some((artifact) =>
    ["instructions", "summary"].includes(artifact.type) || /\.(?:md|mdx|rst|adoc|txt)$/i.test(artifact.path)
  );
}

function nodeHasRequiredMetadata(bundle: ProjectBundle, node: NodeLocation["node"], field: "description" | "tech-stack" | "acceptance-criteria" | "acceptance-check" | "passing-acceptance-check" | "implementation-scope" | "documentation"): boolean {
  if (field === "description") return Boolean(node.description.trim());
  if (field === "tech-stack") return node.techStack.length > 0;
  if (field === "acceptance-criteria") return node.acceptanceCriteria.length > 0;
  if (field === "acceptance-check") return node.acceptanceChecks.length > 0;
  if (field === "passing-acceptance-check") return node.acceptanceChecks.some((check) => check.status === "passing");
  if (field === "implementation-scope") return Boolean(node.implementationScope?.claims.length);
  return nodeHasDocumentation(bundle, node.id);
}

const METADATA_FIELD_LABELS = {
  description: "a description",
  "tech-stack": "at least one technology tag",
  "acceptance-criteria": "acceptance criteria",
  "acceptance-check": "an acceptance test/check",
  "passing-acceptance-check": "a passing acceptance test/check",
  "implementation-scope": "an implementation scope",
  documentation: "linked documentation"
} as const;

export function evaluateArchitecturePolicies(
  bundle: ProjectBundle,
  fileEdges: FileEdge[],
  checkedAt: string,
  previous: ArchitecturePolicyEvaluation | null = null,
  facts: ArchitecturePolicyFacts = {}
): ArchitecturePolicyEvaluation {
  const rules = activePolicyRules(bundle);
  const previousById = new Map((previous?.violations ?? []).map((violation) => [violation.id, violation]));
  const violations: ArchitecturePolicyViolation[] = [];
  const filePaths = repositoryFilePaths(fileEdges, facts);

  const addViolation = (
    rule: NodeRule,
    source: PolicyEndpoint,
    target: PolicyEndpoint | undefined,
    message: string,
    discriminator = ""
  ) => {
    if (violations.length >= 10000 || !rule.constraint) return;
    const id = stableViolationId(rule.id, source.path, target?.path ?? "", discriminator);
    violations.push({
      id,
      policyId: rule.id,
      policyTitle: rule.title,
      kind: rule.constraint.kind,
      severity: rule.severity ?? "warning",
      enforcement: rule.enforcement ?? "advisory",
      message,
      source,
      ...(target ? { target } : {}),
      checkedAt,
      firstSeenAt: previousById.get(id)?.firstSeenAt ?? checkedAt
    });
  };

  for (const rule of rules) {
    const constraint = rule.constraint;
    if (!constraint) continue;
    if (constraint.kind === "forbidden-dependency") {
      for (const edge of dependencyEdges(fileEdges, constraint.includeRuntime)) {
        if (!matchesAnyGlob(edge.from, constraint.fromPathGlobs) || !matchesAnyGlob(edge.to, constraint.toPathGlobs)) continue;
        const evidence = edge.evidence?.find((item) => item.line) ?? edge.evidence?.[0];
        addViolation(rule, fileEndpoint(bundle, edge.from, evidence), fileEndpoint(bundle, edge.to), `${edge.from} must not depend on ${edge.to}. ${rule.body}`);
      }
    } else if (constraint.kind === "required-dependency") {
      const edges = dependencyEdges(fileEdges, constraint.includeRuntime);
      for (const sourcePath of filePaths.filter((filePath) => matchesAnyGlob(filePath, constraint.fromPathGlobs))) {
        if (edges.some((edge) => normalizedPath(edge.from) === sourcePath && matchesAnyGlob(edge.to, constraint.toPathGlobs))) continue;
        addViolation(rule, fileEndpoint(bundle, sourcePath), undefined, `${sourcePath} must depend on at least one file matching ${constraint.toPathGlobs.join(", ")}. ${rule.body}`);
      }
    } else if (constraint.kind === "allowed-dependency") {
      for (const edge of dependencyEdges(fileEdges, constraint.includeRuntime)) {
        if (!matchesAnyGlob(edge.from, constraint.fromPathGlobs) || matchesAnyGlob(edge.to, constraint.allowedPathGlobs)) continue;
        const evidence = edge.evidence?.find((item) => item.line) ?? edge.evidence?.[0];
        addViolation(rule, fileEndpoint(bundle, edge.from, evidence), fileEndpoint(bundle, edge.to), `${edge.from} depends on ${edge.to}, which is outside its allowed dependency areas. ${rule.body}`);
      }
    } else if (constraint.kind === "no-cycles") {
      const scopedEdges = dependencyEdges(fileEdges, constraint.includeRuntime).filter((edge) =>
        matchesAnyGlob(edge.from, constraint.pathGlobs) && matchesAnyGlob(edge.to, constraint.pathGlobs)
      );
      for (const component of stronglyConnectedFileComponents(scopedEdges)) {
        const members = new Set(component);
        const representative = scopedEdges.find((edge) => members.has(edge.from) && members.has(edge.to));
        if (!representative) continue;
        const evidence = representative.evidence?.find((item) => item.line) ?? representative.evidence?.[0];
        addViolation(
          rule,
          fileEndpoint(bundle, representative.from, evidence),
          fileEndpoint(bundle, representative.to),
          `Dependency cycle detected among ${component.join(", ")}. ${rule.body}`,
          component.join("|")
        );
      }
    } else if (constraint.kind === "forbidden-import") {
      for (const parsedFile of facts.parsedFiles ?? []) {
        if (!matchesAnyGlob(parsedFile.relPath, constraint.fromPathGlobs)) continue;
        for (const fileImport of parsedFile.imports) {
          if (!matchesAnyGlob(fileImport.specifier, constraint.importGlobs)) continue;
          const matchedNames = (fileImport.importedNames ?? []).filter((name) => matchesAnyGlob(name, constraint.importedNames));
          if (constraint.importedNames.length && !matchedNames.length) continue;
          const importedDetail = constraint.importedNames.length ? ` (${matchedNames.join(", ")})` : "";
          addViolation(
            rule,
            fileEndpoint(bundle, parsedFile.relPath, { line: fileImport.line, specifier: fileImport.specifier }),
            { entityKind: "external", path: fileImport.specifier, fact: matchedNames.join(", ") || undefined },
            `${parsedFile.relPath} imports forbidden module or API ${fileImport.specifier}${importedDetail}. ${rule.body}`,
            matchedNames.join("|")
          );
        }
      }
    } else if (constraint.kind === "file-convention") {
      for (const filePath of filePaths.filter((candidate) => matchesAnyGlob(candidate, constraint.pathGlobs))) {
        const reasons: string[] = [];
        if (constraint.allowedPathGlobs.length && !matchesAnyGlob(filePath, constraint.allowedPathGlobs)) reasons.push(`must be placed under ${constraint.allowedPathGlobs.join(", ")}`);
        if (constraint.fileNameStyle && !fileNameMatchesStyle(filePath, constraint.fileNameStyle)) reasons.push(`must use ${constraint.fileNameStyle} naming`);
        const fileStem = path.posix.basename(filePath, path.posix.extname(filePath));
        if (constraint.requiredSuffix && !fileStem.endsWith(constraint.requiredSuffix)) reasons.push(`must end with ${constraint.requiredSuffix} before its extension`);
        if (!reasons.length) continue;
        addViolation(rule, fileEndpoint(bundle, filePath), undefined, `${filePath} ${reasons.join(" and ")}. ${rule.body}`);
      }
    } else if (constraint.kind === "required-companion-file") {
      const sourcePaths = filePaths.filter((candidate) => matchesAnyGlob(candidate, constraint.sourcePathGlobs));
      const companionPaths = filePaths.filter((candidate) => matchesAnyGlob(candidate, constraint.companionPathGlobs));
      for (const sourcePath of sourcePaths) {
        const hasCompanion = constraint.match === "any"
          ? companionPaths.length > 0
          : companionPaths.some((candidate) => comparableFileStem(candidate) === comparableFileStem(sourcePath));
        if (hasCompanion) continue;
        addViolation(rule, fileEndpoint(bundle, sourcePath), undefined, `${sourcePath} needs a companion file matching ${constraint.companionPathGlobs.join(", ")}${constraint.match === "same-stem" ? " with the same file name stem" : ""}. ${rule.body}`);
      }
    } else if (constraint.kind === "required-node-metadata") {
      for (const location of scopedNodeLocations(bundle, rule, constraint.scope)) {
        if (nodeHasRequiredMetadata(bundle, location.node, constraint.field)) continue;
        addViolation(rule, nodeEndpoint(location, constraint.field), undefined, `${location.node.title} requires ${METADATA_FIELD_LABELS[constraint.field]}. ${rule.body}`, location.node.id);
      }
    } else if (constraint.kind === "node-relationship") {
      const visitedEdges = new Set<string>();
      for (const location of scopedNodeLocations(bundle, rule, constraint.scope)) {
        const nodeById = new Map(location.flow.nodes.map((node) => [node.id, node]));
        const relationships = location.flow.edges.flatMap((edge) => {
          const candidates = constraint.direction === "incoming"
            ? edge.target === location.node.id ? [{ edge, neighbor: nodeById.get(edge.source) }] : []
            : constraint.direction === "outgoing"
              ? edge.source === location.node.id ? [{ edge, neighbor: nodeById.get(edge.target) }] : []
              : edge.source === location.node.id
                ? [{ edge, neighbor: nodeById.get(edge.target) }]
                : edge.target === location.node.id ? [{ edge, neighbor: nodeById.get(edge.source) }] : [];
          return candidates.filter(({ neighbor }) => neighbor && (!constraint.targetNodeTypes.length || constraint.targetNodeTypes.some((type) => type.toLocaleLowerCase() === neighbor.type.toLocaleLowerCase())));
        });
        if (constraint.mode === "required") {
          if (relationships.length) continue;
          const targetDescription = constraint.targetNodeTypes.length ? ` a ${constraint.targetNodeTypes.join(" or ")} node` : " another node";
          addViolation(rule, nodeEndpoint(location, constraint.direction), undefined, `${location.node.title} requires an ${constraint.direction} relationship with${targetDescription}. ${rule.body}`, location.node.id);
          continue;
        }
        for (const { edge } of relationships) {
          if (visitedEdges.has(edge.id)) continue;
          visitedEdges.add(edge.id);
          const sourceNode = nodeById.get(edge.source);
          const targetNode = nodeById.get(edge.target);
          if (!sourceNode || !targetNode) continue;
          addViolation(
            rule,
            nodeEndpoint({ flow: location.flow, node: sourceNode }, edge.label),
            nodeEndpoint({ flow: location.flow, node: targetNode }, edge.label),
            `${sourceNode.title} must not have this relationship with ${targetNode.title}. ${rule.body}`,
            edge.id
          );
        }
      }
    } else if (constraint.kind === "no-orphan-nodes") {
      for (const location of scopedNodeLocations(bundle, rule, constraint.scope)) {
        if (location.flow.edges.some((edge) => edge.source === location.node.id || edge.target === location.node.id)) continue;
        addViolation(rule, nodeEndpoint(location, "orphan node"), undefined, `${location.node.title} is not connected to another node. ${rule.body}`, location.node.id);
      }
    }
    if (violations.length >= 10000) break;
  }

  violations.sort((left, right) =>
    left.policyTitle.localeCompare(right.policyTitle) || left.source.path.localeCompare(right.source.path) || (left.target?.path ?? "").localeCompare(right.target?.path ?? "")
  );
  return architecturePolicyEvaluationSchema.parse({
    version: 1,
    generatedAt: checkedAt,
    analyzerVersion: POLICY_ANALYZER_VERSION,
    policyFingerprint: architecturePolicyFingerprint(bundle),
    violations,
    stats: {
      policiesEvaluated: rules.length,
      edgesChecked: fileEdges.length,
      violations: violations.length
    }
  });
}

export async function readArchitecturePolicyEvaluation(projectRoot: string): Promise<ArchitecturePolicyEvaluation | null> {
  const raw = await readJson<unknown>(projectStatePath(projectRoot, "runtime", POLICY_EVALUATION_FILE), null);
  const parsed = architecturePolicyEvaluationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function evaluationFingerprint(evaluation: ArchitecturePolicyEvaluation | null): string {
  if (!evaluation) return "missing";
  return JSON.stringify({
    policiesEvaluated: evaluation.stats.policiesEvaluated,
    policyFingerprint: evaluation.policyFingerprint,
    violations: evaluation.violations.map((violation) => ({
      id: violation.id,
      title: violation.policyTitle,
      severity: violation.severity,
      enforcement: violation.enforcement,
      source: violation.source,
      target: violation.target,
      message: violation.message
    }))
  });
}

export async function evaluateAndStoreArchitecturePolicies(
  projectRoot: string,
  bundle: ProjectBundle,
  fileEdges: FileEdge[],
  checkedAt = new Date().toISOString(),
  facts: ArchitecturePolicyFacts = {}
): Promise<ArchitecturePolicyEvaluationResult> {
  const previous = await readArchitecturePolicyEvaluation(projectRoot);
  const evaluation = evaluateArchitecturePolicies(bundle, fileEdges, checkedAt, previous, facts);
  const baselineAvailable = Boolean(previous?.policyFingerprint && previous.policyFingerprint === evaluation.policyFingerprint);
  const previousIds = new Set(baselineAvailable ? previous?.violations.map((violation) => violation.id) ?? [] : []);
  await writeJson(projectStatePath(projectRoot, "runtime", POLICY_EVALUATION_FILE), evaluation);
  return {
    evaluation,
    changed: evaluationFingerprint(previous) !== evaluationFingerprint(evaluation),
    baselineAvailable,
    newViolationIds: evaluation.violations.filter((violation) => !previousIds.has(violation.id)).map((violation) => violation.id)
  };
}

/**
 * Re-evaluate graph-only constraints after a graph edit without rescanning source files.
 * Code-derived findings are preserved only when the persisted policy fingerprint is
 * current; policy-definition changes still go through the full background refresh.
 */
export async function refreshGraphArchitecturePolicyEvaluation(
  projectRoot: string,
  bundle: ProjectBundle,
  checkedAt = new Date().toISOString()
): Promise<ArchitecturePolicyEvaluationResult | null> {
  const previous = await readArchitecturePolicyEvaluation(projectRoot);
  const policyFingerprint = architecturePolicyFingerprint(bundle);
  if (!previous?.policyFingerprint || previous.policyFingerprint !== policyFingerprint) return null;
  const graphRules = activePolicyRules(bundle).filter((rule) => GRAPH_POLICY_KINDS.has(rule.constraint!.kind));
  const graphRuleIds = new Set(graphRules.map((rule) => rule.id));
  const activeRuleIds = new Set(activePolicyRules(bundle).map((rule) => rule.id));
  const graphBundle: ProjectBundle = {
    ...bundle,
    project: {
      ...bundle.project,
      settings: {
        ...bundle.project.settings,
        nodeRules: graphRules
      }
    }
  };
  const graphEvaluation = evaluateArchitecturePolicies(graphBundle, [], checkedAt, previous);
  const violations = [
    ...previous.violations.filter((violation) => activeRuleIds.has(violation.policyId) && !graphRuleIds.has(violation.policyId)),
    ...graphEvaluation.violations
  ].sort((left, right) =>
    left.policyTitle.localeCompare(right.policyTitle) || left.source.path.localeCompare(right.source.path) || (left.target?.path ?? "").localeCompare(right.target?.path ?? "")
  );
  const evaluation = architecturePolicyEvaluationSchema.parse({
    version: 1,
    generatedAt: checkedAt,
    analyzerVersion: POLICY_ANALYZER_VERSION,
    policyFingerprint,
    violations,
    stats: {
      policiesEvaluated: activePolicyRules(bundle).length,
      edgesChecked: previous.stats.edgesChecked,
      violations: violations.length
    }
  });
  const previousIds = new Set(previous.violations.map((violation) => violation.id));
  const changed = evaluationFingerprint(previous) !== evaluationFingerprint(evaluation);
  if (changed) await writeJson(projectStatePath(projectRoot, "runtime", POLICY_EVALUATION_FILE), evaluation);
  return {
    evaluation: changed ? evaluation : previous,
    changed,
    baselineAvailable: true,
    newViolationIds: violations.filter((violation) => !previousIds.has(violation.id)).map((violation) => violation.id)
  };
}

export async function refreshArchitecturePolicyEvaluation(
  projectRoot: string,
  bundle: ProjectBundle
): Promise<ArchitecturePolicyEvaluationResult> {
  const scan = await scanRepository(projectRoot);
  const parsed = await parseFiles(projectRoot, scan.files);
  const fileGraph = await buildFileDependencyGraph(projectRoot, scan, parsed);
  const inventory = await buildContentInventory(projectRoot, scan);
  addHighConfidenceRuntimeEdges(fileGraph, inventory);
  return evaluateAndStoreArchitecturePolicies(projectRoot, bundle, fileGraph.edges, new Date().toISOString(), {
    files: scan.files,
    parsedFiles: parsed
  });
}
