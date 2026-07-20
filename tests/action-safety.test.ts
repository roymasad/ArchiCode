import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assessAgentCommandSafety } from "../src/main/actionSafety";
import { ensureFixtureProject } from "../src/main/storage/projectStore";

async function fixture(): Promise<{ root: string; settings: Awaited<ReturnType<typeof ensureFixtureProject>>["project"]["settings"] }> {
  const root = await mkdtemp(path.join(tmpdir(), "archicode-action-safety-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    scripts: {
      build: "vite build",
      test: "vitest run",
      dev: "vite"
    }
  }), "utf8");
  const bundle = await ensureFixtureProject(root);
  return { root, settings: { ...bundle.project.settings, autoApproveShellCommands: false } };
}

describe("shared agent command safety broker", () => {
  it("covers project-local verification semantically without pinning command names", async () => {
    const { root, settings } = await fixture();
    await expect(assessAgentCommandSafety({
      projectRoot: root,
      settings,
      command: "npm run build",
      cwd: root,
      authorization: { actor: "delphi", capabilities: ["verify-project"] }
    })).resolves.toMatchObject({ decision: "execute", capability: "verify-project" });

    await expect(assessAgentCommandSafety({
      projectRoot: root,
      settings,
      command: "npm install playwright",
      cwd: root,
      authorization: { actor: "delphi", capabilities: ["verify-project"] }
    })).resolves.toMatchObject({ decision: "approval-required" });
  });

  it("separates verification from runtime control without a binary whitelist", async () => {
    const { root, settings } = await fixture();
    await expect(assessAgentCommandSafety({
      projectRoot: root,
      settings,
      command: "npm run dev",
      cwd: root,
      authorization: { actor: "delphi", capabilities: ["verify-project"] }
    })).resolves.toMatchObject({ decision: "approval-required" });

    await expect(assessAgentCommandSafety({
      projectRoot: root,
      settings,
      command: "npm run dev",
      cwd: root,
      authorization: { actor: "delphi", capabilities: ["control-runtime"] }
    })).resolves.toMatchObject({ decision: "execute", capability: "control-runtime" });
  });

  it("lets Parent Chat choose any non-code project action without an executable whitelist", async () => {
    const { root, settings } = await fixture();
    await expect(assessAgentCommandSafety({
      projectRoot: root,
      settings: {
        ...settings,
        researchAutoApproveGraphChanges: { enabled: true, includeDestructive: false }
      },
      command: "project-specific-inspector --summary",
      cwd: root,
      authorization: { actor: "parent-chat" }
    })).resolves.toMatchObject({ decision: "execute", risk: "medium" });

    await expect(assessAgentCommandSafety({
      projectRoot: root,
      settings: {
        ...settings,
        researchAutoApproveGraphChanges: { enabled: true, includeDestructive: false }
      },
      command: "tee src/app.ts",
      cwd: root,
      authorization: { actor: "parent-chat" }
    })).resolves.toMatchObject({ decision: "redirect" });
  });

  it("resumes the exact approved uncertain action through the same broker", async () => {
    const { root, settings } = await fixture();
    const input = {
      projectRoot: root,
      settings,
      command: "npm run dev",
      cwd: root,
      authorization: { actor: "parent-chat" as const }
    };
    await expect(assessAgentCommandSafety(input)).resolves.toMatchObject({ decision: "approval-required" });
    await expect(assessAgentCommandSafety({
      ...input,
      authorization: { actor: "parent-chat", exactCommandApproved: true }
    })).resolves.toMatchObject({ decision: "execute" });
  });

  it("uses the Chat auto-approve toggle, not the separate agent shell preference, for Parent actions", async () => {
    const { root, settings } = await fixture();
    await expect(assessAgentCommandSafety({
      projectRoot: root,
      settings: {
        ...settings,
        autoApproveShellCommands: true,
        researchAutoApproveGraphChanges: { enabled: false, includeDestructive: false }
      },
      command: "project-specific-inspector --summary",
      cwd: root,
      authorization: { actor: "parent-chat" }
    })).resolves.toMatchObject({ decision: "approval-required", risk: "medium" });
  });

  it("auto-approves simple project-document output without permitting source edits", async () => {
    const { root, settings } = await fixture();
    const autoApproveSettings = {
      ...settings,
      researchAutoApproveGraphChanges: { enabled: true, includeDestructive: false }
    };
    await expect(assessAgentCommandSafety({
      projectRoot: root,
      settings: autoApproveSettings,
      command: "printf 'lorem ipsum\\n' > test.txt",
      cwd: root,
      authorization: { actor: "parent-chat" }
    })).resolves.toMatchObject({ decision: "execute", risk: "medium" });

    await expect(assessAgentCommandSafety({
      projectRoot: root,
      settings: autoApproveSettings,
      command: "printf 'changed\\n' > src/app.ts",
      cwd: root,
      authorization: { actor: "parent-chat" }
    })).resolves.toMatchObject({ decision: "redirect", risk: "medium" });

    await expect(assessAgentCommandSafety({
      projectRoot: root,
      settings: {
        ...autoApproveSettings,
        researchAutoApproveGraphChanges: { enabled: false, includeDestructive: false }
      },
      command: "printf 'lorem ipsum\\n' > test.txt",
      cwd: root,
      authorization: { actor: "parent-chat" }
    })).resolves.toMatchObject({ decision: "approval-required", risk: "medium" });
  });
});
