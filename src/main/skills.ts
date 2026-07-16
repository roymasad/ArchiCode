import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CreateProjectSkillInput, ProjectSkill } from "../shared/capabilities";
import type { ProjectSettings } from "../shared/schema";

const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

function skillsRoot(projectRoot: string): string {
  return path.join(projectRoot, ".archicode", "skills");
}

function skillPath(projectRoot: string, skillId: string): string {
  return path.join(skillsRoot(projectRoot), skillId, "SKILL.md");
}

function skillMetadata(content: string): { title: string; description: string } {
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || "Untitled Skill";
  const description = content.match(/^description:\s*(.+)$/im)?.[1]?.trim() ||
    content.match(/^##\s+Description\s*\n+([\s\S]*?)(?:\n##\s+|\n?$)/im)?.[1]?.trim().split("\n")[0] ||
    "";
  return { title, description };
}

export function validateSkillId(skillId: string): string {
  const normalized = skillId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  if (!SKILL_ID_PATTERN.test(normalized)) {
    throw new Error("Skill id must be 3-64 lowercase letters, numbers, or hyphens.");
  }
  return normalized;
}

export async function listProjectSkills(projectRoot: string, settings?: ProjectSettings): Promise<ProjectSkill[]> {
  await mkdir(skillsRoot(projectRoot), { recursive: true });
  const entries = await readdir(skillsRoot(projectRoot), { withFileTypes: true });
  const enabled = new Set(settings?.skills.enabledSkillIds ?? []);
  const skills: ProjectSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    try {
      const content = await readFile(skillPath(projectRoot, id), "utf8");
      const metadata = skillMetadata(content);
      skills.push({
        id,
        title: metadata.title,
        description: metadata.description,
        path: `.archicode/skills/${id}/SKILL.md`,
        enabled: enabled.has(id),
        content
      });
    } catch {
      continue;
    }
  }
  return skills.sort((a, b) => a.title.localeCompare(b.title));
}

export async function createProjectSkill(projectRoot: string, input: CreateProjectSkillInput): Promise<ProjectSkill> {
  const skillId = validateSkillId(input.id);
  const title = input.title.trim();
  if (!title) throw new Error("Skill title is required.");
  const description = input.description?.trim() || "Project-local ArchiCode skill.";
  const whenToUse = input.whenToUse?.trim() || "Use this skill when the project task matches the title and description.";
  const instructions = input.instructions?.trim() || "Add focused, project-specific guidance here.";
  const content = [
    `# ${title}`,
    "",
    `description: ${description}`,
    "",
    "## When To Use",
    whenToUse,
    "",
    "## Instructions",
    instructions,
    ""
  ].join("\n");
  await mkdir(path.dirname(skillPath(projectRoot, skillId)), { recursive: true });
  await writeFile(skillPath(projectRoot, skillId), content, { encoding: "utf8", flag: "wx" });
  return {
    id: skillId,
    title,
    description,
    path: `.archicode/skills/${skillId}/SKILL.md`,
    enabled: false,
    content
  };
}

export async function selectedSkillsPrompt(projectRoot: string, settings: ProjectSettings): Promise<string> {
  const enabledIds = new Set(settings.skills.enabledSkillIds);
  if (!enabledIds.size) return "";
  const skills = (await listProjectSkills(projectRoot, settings)).filter((skill) => enabledIds.has(skill.id) && skill.content?.trim());
  if (!skills.length) return "";
  return [
    "Selected ArchiCode Skills",
    "These project-local skills are enabled for this run. Follow them when relevant, while still obeying the run phase and project context.",
    "",
    ...skills.map((skill) => [
      `## ${skill.title} (${skill.id})`,
      skill.content?.trim() ?? ""
    ].join("\n"))
  ].join("\n\n");
}
