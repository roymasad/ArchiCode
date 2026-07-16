import { z } from "zod";
import { nodeVisualShapeSchema } from "../../shared/schema";
import type { ImportAnnotations, ModuleGraph } from "./types";

const colorPattern = /^#[0-9a-fA-F]{6}$/;

const visualSchema = z.object({
  backgroundColor: z.string().optional(),
  shape: z.string().optional()
}).optional();

export const importAnnotationsSchema = z.object({
  projectNode: z.object({
    title: z.string().default(""),
    description: z.string().default(""),
    techStack: z.array(z.string()).default([]),
    acceptanceCriteria: z.array(z.string()).default([]),
    visual: visualSchema
  }),
  clusters: z.array(z.object({
    id: z.string(),
    title: z.string().default(""),
    type: z.string().default(""),
    description: z.string().default(""),
    techStack: z.array(z.string()).default([]),
    acceptanceCriteria: z.array(z.string()).default([]),
    visual: visualSchema,
    groupName: z.string().optional(),
    mergeInto: z.string().optional()
  })).default([]),
  groups: z.array(z.object({
    name: z.string(),
    color: z.string().optional(),
    memberClusterIds: z.array(z.string()).default([])
  })).default([]),
  edgeLabels: z.array(z.object({
    source: z.string(),
    target: z.string(),
    label: z.string()
  })).default([]),
  subflowNames: z.array(z.string()).default([]),
  summary: z.string().default("")
});

const VAGUE_LANGUAGE = /(such as|for example|e\.g\.|\betc\b\.?|and more\b|and others?\b|various\b|and so on)/i;

export function validateImportAnnotations(annotations: ImportAnnotations, graph: ModuleGraph, _levels: string): string[] {
  const errors: string[] = [];
  const clusterIds = new Set(graph.clusters.map((cluster) => cluster.id));
  const annotatedIds = new Set<string>();

  if (!annotations.projectNode.title.trim()) errors.push("projectNode.title is empty.");
  if (!annotations.projectNode.description.trim()) errors.push("projectNode.description is empty.");
  if (VAGUE_LANGUAGE.test(annotations.projectNode.description)) errors.push("projectNode.description uses vague briefing language; describe ownership completely.");

  const mergeTargets = new Map<string, string>();
  for (const cluster of annotations.clusters) {
    if (!clusterIds.has(cluster.id)) {
      errors.push(`Annotation references unknown cluster id "${cluster.id}". Only annotate the provided clusters.`);
      continue;
    }
    if (annotatedIds.has(cluster.id)) errors.push(`Cluster "${cluster.id}" is annotated more than once.`);
    annotatedIds.add(cluster.id);
    if (cluster.mergeInto) {
      mergeTargets.set(cluster.id, cluster.mergeInto);
      continue;
    }
    if (!cluster.title.trim()) errors.push(`Cluster "${cluster.id}" is missing a title.`);
    if (!cluster.description.trim()) errors.push(`Cluster "${cluster.id}" is missing a description.`);
    if (cluster.description && VAGUE_LANGUAGE.test(cluster.description)) {
      errors.push(`Cluster "${cluster.id}" description uses vague briefing language ("such as"/"etc"); state exactly what it owns.`);
    }
    if (cluster.visual?.backgroundColor && !colorPattern.test(cluster.visual.backgroundColor)) {
      errors.push(`Cluster "${cluster.id}" backgroundColor must be a 6-digit hex color.`);
    }
    if (cluster.visual?.shape && !nodeVisualShapeSchema.safeParse(cluster.visual.shape).success) {
      errors.push(`Cluster "${cluster.id}" shape "${cluster.visual.shape}" is not one of: ${nodeVisualShapeSchema.options.join(", ")}.`);
    }
  }

  const tierById = new Map(graph.clusters.map((cluster) => [cluster.id, cluster.tier]));
  for (const [source, target] of mergeTargets) {
    if (!clusterIds.has(target)) {
      errors.push(`Cluster "${source}" merges into unknown cluster "${target}".`);
      continue;
    }
    if (mergeTargets.has(target)) errors.push(`Cluster "${source}" merges into "${target}", which is itself merged; merge directly into the surviving cluster.`);
    if (tierById.get(source) !== tierById.get(target)) errors.push(`Cluster "${source}" can only merge into a cluster on the same level.`);
  }

  for (const clusterId of clusterIds) {
    if (!annotatedIds.has(clusterId)) errors.push(`Cluster "${clusterId}" was not annotated; annotate every provided cluster exactly once.`);
  }

  const survivingId = (id: string): string => mergeTargets.get(id) ?? id;
  const edgePairs = new Set(graph.edges.map((edge) => `${survivingId(edge.source)} ${survivingId(edge.target)}`));
  for (const edgeLabel of annotations.edgeLabels) {
    if (!edgePairs.has(`${survivingId(edgeLabel.source)} ${survivingId(edgeLabel.target)}`)) {
      errors.push(`Edge label "${edgeLabel.label}" references ${edgeLabel.source} -> ${edgeLabel.target}, which is not a detected dependency. Only label the provided edges.`);
    }
  }

  for (const group of annotations.groups) {
    if (!group.name.trim()) errors.push("A group is missing a name.");
    if (group.color && !colorPattern.test(group.color)) errors.push(`Group "${group.name}" color must be a 6-digit hex color.`);
    for (const memberId of group.memberClusterIds) {
      if (!clusterIds.has(memberId)) {
        errors.push(`Group "${group.name}" references unknown cluster "${memberId}".`);
        continue;
      }
      if (mergeTargets.has(memberId)) continue;
    }
    const memberTiers = new Set(group.memberClusterIds.filter((memberId) => clusterIds.has(memberId)).map((memberId) => tierById.get(survivingId(memberId))));
    if (memberTiers.size > 1) errors.push(`Group "${group.name}" mixes clusters from different levels; groups must stay within one level.`);
  }

  return errors.slice(0, 16);
}
