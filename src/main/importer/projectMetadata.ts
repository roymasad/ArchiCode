import path from "node:path";
import type { Flow, Project, ProjectSettings } from "../../shared/schema";

export function importedProjectMetadata(
  projectRoot: string,
  evidenceFlow: Flow
): Partial<Pick<Project, "name" | "description">> & Partial<Pick<ProjectSettings, "stackAssumptions" | "environmentNotes">> {
  const projectNode = evidenceFlow.nodes.find((node) => node.id === "node-project");
  const proposedName = projectNode?.title.trim() || "";
  const name = proposedName && !/^(?:product|project|codebase|application)(?:\s+name)?$/i.test(proposedName) ? proposedName : path.basename(projectRoot);
  const description = projectNode?.description.trim() || `${name} was imported from an existing codebase.`;
  const observedStackCounts = new Map<string, { value: string; count: number }>();
  for (const node of evidenceFlow.nodes) {
    if (node.subjectRef?.kind !== "code") continue;
    for (const item of node.techStack) {
      const value = item.trim();
      if (!value || value === "Source files") continue;
      const key = value.toLowerCase();
      const current = observedStackCounts.get(key);
      observedStackCounts.set(key, { value, count: (current?.count ?? 0) + 1 });
    }
  }
  const projectStack = (projectNode?.techStack ?? []).filter((item) => item.trim() && item !== "Source files");
  const stackAssumptions = observedStackCounts.size
    ? [...new Set([
      ...projectStack.filter((item) => observedStackCounts.has(item.toLowerCase())),
      ...[...observedStackCounts.values()].sort((left, right) => right.count - left.count || left.value.localeCompare(right.value)).map((item) => item.value)
    ])].slice(0, 12)
    : projectStack;
  return {
    name,
    description,
    stackAssumptions,
    environmentNotes: "Imported existing codebase. Architecture descriptions and stack assumptions were reverse-engineered from repository evidence; run targets are detected separately from manifests and source entrypoints."
  };
}
