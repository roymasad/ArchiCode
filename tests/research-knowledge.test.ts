import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCompactResearchContext } from "../src/main/research/contextAssembly";
import { callResearchProjectFileTool } from "../src/main/research/inspectionTools";
import { createResearchChat, setResearchStorageRoot } from "../src/main/research/chatStore";
import {
  createChatArtifact,
  createProjectMemoryNote,
  listChatArtifacts,
  listProjectMemoryNotes,
  readChatArtifact,
  readProjectMemoryNote,
  updateChatArtifact,
  updateProjectMemoryNote
} from "../src/main/storage/researchKnowledge";
import { ensureFixtureProject, loadProject } from "../src/main/storage/projectStore";

async function researchProject(prefix: string) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), prefix));
  setResearchStorageRoot(await mkdtemp(path.join(tmpdir(), `${prefix}chat-store-`)));
  const bundle = await ensureFixtureProject(projectRoot);
  const chat = await createResearchChat({
    projectRoot,
    scope: { type: "project", projectId: bundle.project.id }
  });
  return { projectRoot, bundle, chat };
}

describe("project memory notes and chat artifacts", () => {
  it("keeps small memory notes project-owned, revision-safe, and available to later chats", async () => {
    const { projectRoot, bundle, chat } = await researchProject("archicode-project-memory-");
    const note = await createProjectMemoryNote(projectRoot, {
      title: "Authentication direction",
      body: "Use rotating refresh tokens and keep access tokens short lived.",
      scope: { type: "project", projectId: bundle.project.id },
      pinned: true,
      originChatId: chat.id,
      sourceMessageIds: ["message-auth"]
    });
    const laterChat = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: bundle.project.id }
    });

    expect(laterChat.id).not.toBe(chat.id);
    expect((await listProjectMemoryNotes(projectRoot)).map((item) => item.id)).toContain(note.id);
    await expect(readProjectMemoryNote(projectRoot, "../../project.json")).rejects.toThrow(/unsupported characters/);
    expect(await readFile(path.join(projectRoot, ".gitignore"), "utf8")).toContain(".archicode/memory-notes/");
    const context = await buildCompactResearchContext(projectRoot, await loadProject(projectRoot), laterChat.scope);
    expect(context).toContain("Authentication direction");
    expect(context).toContain("rotating refresh tokens");

    const updated = await updateProjectMemoryNote(projectRoot, note.id, {
      expectedRevision: 1,
      body: "Use rotating refresh tokens; access tokens expire after ten minutes."
    });
    expect(updated.revision).toBe(2);
    await expect(updateProjectMemoryNote(projectRoot, note.id, {
      expectedRevision: 1,
      body: "This stale update must not win."
    })).rejects.toThrow(/current revision is 2/);

    await updateProjectMemoryNote(projectRoot, note.id, { expectedRevision: 2, status: "archived" });
    expect(await listProjectMemoryNotes(projectRoot)).toEqual([]);
    expect(await listProjectMemoryNotes(projectRoot, { includeArchived: true })).toHaveLength(1);
  });

  it("stores large artifacts under their owning chat and prevents cross-chat reads", async () => {
    const { projectRoot, bundle, chat } = await researchProject("archicode-chat-artifact-");
    const otherChat = await createResearchChat({
      projectRoot,
      scope: { type: "project", projectId: bundle.project.id }
    });
    const artifact = await createChatArtifact(projectRoot, chat.id, {
      title: "Authentication investigation",
      content: "# Findings\n\nA detailed session report.",
      format: "markdown",
      summary: "Detailed authentication findings."
    });

    expect(artifact.chatId).toBe(chat.id);
    expect(artifact.path).toContain(`.archicode/artifacts/chats/${chat.id}/`);
    expect((await listChatArtifacts(projectRoot, chat.id)).map((item) => item.id)).toEqual([artifact.id]);
    expect(await listChatArtifacts(projectRoot, otherChat.id)).toEqual([]);
    await expect(readChatArtifact(projectRoot, otherChat.id, artifact.id)).rejects.toThrow(/was not found/);
    expect((await readChatArtifact(projectRoot, chat.id, artifact.id)).text).toContain("detailed session report");

    const updated = await updateChatArtifact(projectRoot, chat.id, artifact.id, {
      expectedRevision: 1,
      content: "# Findings\n\nUpdated detailed report."
    });
    expect(updated.revision).toBe(2);
    await expect(updateChatArtifact(projectRoot, chat.id, artifact.id, {
      expectedRevision: 1,
      summary: "Stale write"
    })).rejects.toThrow(/current revision is 2/);

    const reloaded = await loadProject(projectRoot);
    expect(reloaded.artifacts).toContainEqual(expect.objectContaining({ id: artifact.id, type: "chat-artifact", chatId: chat.id }));
    expect(await readFile(path.join(projectRoot, artifact.path), "utf8")).toContain("Updated detailed report");
    const otherChatContext = await buildCompactResearchContext(projectRoot, reloaded, otherChat.scope);
    expect(otherChatContext).not.toContain("Authentication investigation");
    expect(otherChatContext).not.toContain("Detailed authentication findings");
  });

  it("gives Research bounded note and artifact tools without accepting a model-selected chat id", async () => {
    const { projectRoot, bundle, chat } = await researchProject("archicode-research-knowledge-tools-");
    const context = { sessionId: chat.id, sessionScope: chat.scope };
    const remembered = await callResearchProjectFileTool(projectRoot, {
      providerToolName: "archicode_project_remember_note",
      argumentsJson: JSON.stringify({
        title: "Deployment preference",
        body: "Use the staging API token sk-this-should-be-redacted-123456 before production."
      })
    }, context);
    expect(remembered.resultText).toContain("[redacted-secret]");
    expect(remembered.resultText).not.toContain("sk-this-should-be-redacted-123456");

    const created = await callResearchProjectFileTool(projectRoot, {
      providerToolName: "archicode_chat_create_artifact",
      argumentsJson: JSON.stringify({ title: "Release checklist", content: "- verify build\n- ship", format: "markdown" })
    }, context);
    const createdBody = JSON.parse(created.resultText) as { artifact: { id: string; chatId: string } };
    expect(createdBody.artifact.chatId).toBe(chat.id);

    await expect(callResearchProjectFileTool(projectRoot, {
      providerToolName: "archicode_project_read_artifact",
      argumentsJson: JSON.stringify({ artifactId: createdBody.artifact.id })
    }, context)).rejects.toThrow(/owning chat/);

    const listed = await callResearchProjectFileTool(projectRoot, {
      providerToolName: "archicode_chat_list_artifacts",
      argumentsJson: "{}"
    }, context);
    expect(listed.resultText).toContain(createdBody.artifact.id);
    expect((await listProjectMemoryNotes(projectRoot))[0]?.scope).toEqual({ type: "project", projectId: bundle.project.id });
  });
});
