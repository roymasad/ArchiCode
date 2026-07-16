import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatchProposal, listPatchProposals } from "../src/main/storage/patches";
import { ensureProject, loadProject, updateProjectSettings } from "../src/main/storage/projectStore";
import { persistAndMaybeApplyPatchProposal } from "../src/main/storage/runEngine";

async function createProjectWithProposal(kind: "unlocked" | "locked") {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "archicode-patch-test-"));
  await ensureProject(projectRoot);
  await mkdir(path.join(projectRoot, ".archicode", "artifacts"), { recursive: true });

  const nodeId = kind === "locked" ? "node-approved-contract" : "node-project";
  const artifact = {
    id: `artifact-${kind}`,
    type: "generated-file",
    title: `${kind} patch proposal`,
    path: `.archicode/artifacts/${kind}-patch.json`,
    runId: `run-${kind}`,
    status: "pending-review",
    createdAt: "2026-06-15T18:00:00.000Z",
    archicodePatch: {
      schemaVersion: 1,
      runId: `run-${kind}`,
      summary: `Update ${nodeId}`,
      operations: [
        {
          kind: "update-node",
          flowId: "flow-main",
          patch: {
            id: nodeId,
            description: `Updated by ${kind} patch`
          }
        }
      ]
    }
  };

  await writeFile(
    path.join(projectRoot, artifact.path),
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8"
  );

  return { projectRoot, artifact };
}

describe("patch proposal workflow", () => {
  it("preserves unusable provider handoffs as recoverable proposal artifacts", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "archicode-invalid-handoff-test-"));
    await ensureProject(projectRoot);

    const persisted = await persistAndMaybeApplyPatchProposal(projectRoot, "run-invalid", JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        summary: "Invalid operation",
        operations: [{ kind: "write-file", path: "src/app.ts" }]
      }
    }));
    const proposals = await listPatchProposals(projectRoot);

    expect(persisted?.pendingReview).toBe(true);
    expect(persisted?.artifact.title).toContain("Unusable provider handoff");
    expect(proposals[0]?.validationErrors.length).toBeGreaterThan(0);
    const raw = await readFile(path.join(projectRoot, persisted!.artifact.path), "utf8");
    expect(raw).toContain("could not safely use");
  });

  it("auto-applies safe graph bookkeeping patches and logs skipped content edits", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "archicode-patch-auto-test-"));
    await ensureProject(projectRoot);

    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        summary: "Ask for a product decision and mark attention",
        operations: [
          {
            kind: "update-node",
            flowId: "flow-main",
            patch: {
              id: "node-project",
              flags: ["changed", "needs-attention", "llm-question"]
            }
          },
          {
            kind: "add-note",
            note: {
              flowId: "flow-main",
              nodeId: "node-project",
              kind: "llm-question",
              author: "llm",
              body: "Which launch surface should this project target first?",
              resolved: false
            }
          },
          {
            kind: "update-node",
            flowId: "flow-main",
            patch: {
              id: "node-project",
              description: "This content edit should not auto-apply."
            }
          }
        ]
      }
    });

    const persisted = await persistAndMaybeApplyPatchProposal(projectRoot, "run-auto", output);
    const bundle = await loadProject(projectRoot);
    const node = bundle.flows[0]?.nodes.find((item) => item.id === "node-project");
    const proposals = await listPatchProposals(projectRoot);

    expect(persisted?.autoApplied).toBe(true);
    expect(persisted?.pendingReview).toBe(false);
    expect(node?.flags).toContain("llm-question");
    expect(node?.description).not.toBe("This content edit should not auto-apply.");
    expect(bundle.notes.some((note) => note.kind === "llm-question" && note.nodeId === "node-project")).toBe(true);
    expect(proposals[0]?.artifact.status).toBe("partially-applied");
    expect(proposals[0]?.review?.results[2]?.status).toBe("rejected");
  });

  it("auto-applies normalized LLM question notes instead of preserving them as invalid handoffs", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "archicode-question-normalize-test-"));
    await ensureProject(projectRoot);

    const output = [
      "Decision: ask_questions",
      "",
      "```json",
      JSON.stringify({
        archicodePatch: {
          schemaVersion: 1,
          summary: "Ask before scaffolding.",
          operations: [
            {
              kind: "add-note",
              nodeId: "node-project",
              note: {
                kind: "llm-question",
                author: "llm",
                body: "Which stack should this workspace actually scaffold?",
                category: "question",
                priority: "high"
              }
            }
          ]
        }
      }, null, 2),
      "```"
    ].join("\n");

    const persisted = await persistAndMaybeApplyPatchProposal(projectRoot, "run-questions", output);
    const bundle = await loadProject(projectRoot);
    const proposals = await listPatchProposals(projectRoot);
    const question = bundle.notes.find((note) => note.kind === "llm-question" && note.nodeId === "node-project");
    const node = bundle.flows[0]?.nodes.find((item) => item.id === "node-project");

    expect(persisted?.autoApplied).toBe(true);
    expect(persisted?.pendingReview).toBe(false);
    expect(persisted?.artifact.title).not.toContain("Unusable provider handoff");
    expect(proposals[0]?.validationErrors).toHaveLength(0);
    expect(question?.body).toBe("Which stack should this workspace actually scaffold?");
    expect(question?.category).toBe("note");
    expect(question?.priority).toBe("high");
    expect(node?.flags).toContain("llm-question");
  });

  it("skips planning questions when plan review is automatic", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "archicode-question-auto-plan-test-"));
    await ensureProject(projectRoot);

    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        summary: "Ask before scaffolding.",
        operations: [
          {
            kind: "add-note",
            note: {
              flowId: "flow-main",
              nodeId: "node-project",
              kind: "llm-question",
              author: "llm",
              body: "Which stack should this workspace actually scaffold?",
              category: "note",
              priority: "high"
            }
          }
        ]
      }
    });

    const persisted = await persistAndMaybeApplyPatchProposal(projectRoot, "run-auto-plan-question", output, { phase: "planning" });
    const bundle = await loadProject(projectRoot);
    const proposals = await listPatchProposals(projectRoot);

    expect(persisted?.autoApplied).toBe(true);
    expect(persisted?.pendingReview).toBe(false);
    expect(bundle.notes.some((note) => note.body === "Which stack should this workspace actually scaffold?")).toBe(false);
    expect(proposals[0]?.review?.results[0]?.status).toBe("rejected");
    expect(proposals[0]?.review?.results[0]?.message).toContain("Skipped planning question");
  });

  it("does not duplicate identical open LLM questions on repeated handoffs", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "archicode-question-dedupe-test-"));
    await ensureProject(projectRoot);

    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        summary: "Ask before scaffolding.",
        operations: [
          {
            kind: "add-note",
            nodeId: "node-project",
            note: {
              kind: "llm-question",
              author: "llm",
              body: "Which stack should this workspace actually scaffold?",
              category: "question",
              priority: "high"
            }
          }
        ]
      }
    });

    await persistAndMaybeApplyPatchProposal(projectRoot, "run-questions-a", output);
    await persistAndMaybeApplyPatchProposal(projectRoot, "run-questions-b", output);

    const bundle = await loadProject(projectRoot);
    const matching = bundle.notes.filter((note) =>
      note.kind === "llm-question" &&
      note.nodeId === "node-project" &&
      note.body === "Which stack should this workspace actually scaffold?"
    );

    expect(matching).toHaveLength(1);
  });

  it("keeps LLM approval attempts out of auto-apply and fails them if accepted", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "archicode-patch-approval-test-"));
    const initial = await ensureProject(projectRoot);
    await updateProjectSettings(projectRoot, {
      ...initial.project.settings,
      planningReviewMode: "manual"
    });

    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        summary: "Try to approve a node",
        operations: [
          {
            kind: "update-node",
            flowId: "flow-main",
            patch: {
              id: "node-canvas",
              stage: "draft-approved-production",
              flags: ["changed", "user-approved"],
              locked: true
            }
          }
        ]
      }
    });

    const persisted = await persistAndMaybeApplyPatchProposal(projectRoot, "run-approval", output, { phase: "planning" });
    let proposals = await listPatchProposals(projectRoot);
    let bundle = await loadProject(projectRoot);
    let node = bundle.flows[0]?.nodes.find((item) => item.id === "node-canvas");

    expect(persisted?.pendingReview).toBe(true);
    expect(persisted?.autoApplied).toBe(false);
    expect(node?.stage).toBe("working");
    expect(node?.flags).not.toContain("user-approved");

    bundle = await applyPatchProposal(projectRoot, proposals[0]!.artifact.id, [
      { operationIndex: 0, decision: "accepted" }
    ]);
    proposals = await listPatchProposals(projectRoot);
    node = bundle.flows[0]?.nodes.find((item) => item.id === "node-canvas");

    expect(proposals[0]?.review?.results[0]?.status).toBe("failed");
    expect(proposals[0]?.review?.results[0]?.message).toMatch(/cannot approve nodes/);
    expect(node?.stage).toBe("working");
    expect(node?.flags).not.toContain("user-approved");
    expect(node?.locked).toBe(false);
  });

  it("keeps proposed graph structure pending until accepted", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "archicode-structure-proposal-test-"));
    const initial = await ensureProject(projectRoot);
    await updateProjectSettings(projectRoot, {
      ...initial.project.settings,
      planningReviewMode: "manual"
    });

    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        summary: "Suggest a provider health node.",
        operations: [
          {
            kind: "propose-node",
            flowId: "flow-main",
            node: {
              id: "node-provider-health",
              type: "task",
              title: "Provider Health",
              description: "Check provider configuration and account readiness before agent runs.",
              position: { x: 720, y: 420 }
            }
          },
          {
            kind: "propose-edge",
            flowId: "flow-main",
            edge: {
              id: "edge-orchestrator-provider-health",
              source: "node-orchestrator",
              target: "node-provider-health",
              label: "checks"
            }
          }
        ]
      }
    });

    const persisted = await persistAndMaybeApplyPatchProposal(projectRoot, "run-propose", output, { phase: "planning" });
    let bundle = await loadProject(projectRoot);
    let proposals = await listPatchProposals(projectRoot);

    expect(persisted?.pendingReview).toBe(true);
    expect(bundle.flows[0]?.nodes.some((node) => node.id === "node-provider-health")).toBe(false);
    expect(proposals[0]?.artifact.status).toBe("pending-review");

    bundle = await applyPatchProposal(projectRoot, proposals[0]!.artifact.id, [
      { operationIndex: 0, decision: "accepted" },
      { operationIndex: 1, decision: "accepted" }
    ]);
    proposals = await listPatchProposals(projectRoot);

    expect(bundle.flows[0]?.nodes.some((node) => node.id === "node-provider-health")).toBe(true);
    expect(bundle.flows[0]?.edges.some((edge) => edge.id === "edge-orchestrator-provider-health")).toBe(true);
    expect(proposals[0]?.artifact.status).toBe("applied");
  });

  it("does not leave planning graph proposals pending when plan review is automatic", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "archicode-plan-auto-structure-test-"));
    await ensureProject(projectRoot);

    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        summary: "Suggest a provider health node.",
        operations: [
          {
            kind: "propose-node",
            flowId: "flow-main",
            node: {
              id: "node-provider-health",
              type: "task",
              title: "Provider Health",
              description: "Check provider configuration and account readiness before agent runs.",
              position: { x: 720, y: 420 }
            }
          }
        ]
      }
    });

    const persisted = await persistAndMaybeApplyPatchProposal(projectRoot, "run-plan-auto-propose", output, {
      phase: "planning"
    });
    const bundle = await loadProject(projectRoot);
    const proposals = await listPatchProposals(projectRoot);

    expect(persisted?.pendingReview).toBe(false);
    expect(bundle.flows[0]?.nodes.some((node) => node.id === "node-provider-health")).toBe(false);
    expect(proposals[0]?.artifact.status).toBe("rejected");
    expect(proposals[0]?.review?.results[0]?.message).toContain("Skipped in automatic mode");
  });

  it("rejects proposed nodes that arrive pre-approved", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "archicode-proposed-approval-test-"));
    await ensureProject(projectRoot);

    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        summary: "Suggest an already-approved node.",
        operations: [
          {
            kind: "propose-node",
            flowId: "flow-main",
            node: {
              id: "node-self-approved",
              type: "task",
              title: "Self Approved Task",
              description: "This should not be born approved.",
              stage: "draft-approved-production",
              flags: ["user-approved"],
              locked: true
            }
          }
        ]
      }
    });

    await persistAndMaybeApplyPatchProposal(projectRoot, "run-propose-approved", output);
    const proposals = await listPatchProposals(projectRoot);
    const bundle = await applyPatchProposal(projectRoot, proposals[0]!.artifact.id, [
      { operationIndex: 0, decision: "accepted" }
    ]);

    expect(bundle.flows[0]?.nodes.some((node) => node.id === "node-self-approved")).toBe(false);
    expect((await listPatchProposals(projectRoot))[0]?.review?.results[0]?.status).toBe("failed");
  });

  it("carries acceptance checks and module binding on a proposed new node", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "archicode-proposed-checks-test-"));
    await ensureProject(projectRoot);

    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        summary: "Propose a node with acceptance checks.",
        operations: [
          {
            kind: "propose-node",
            flowId: "flow-main",
            node: {
              id: "node-with-checks",
              type: "feature",
              title: "Password Reset",
              description: "Reset password via emailed link.",
              stage: "draft",
              acceptanceCriteria: ["User can reset via email"],
              acceptanceChecks: [
                { id: "chk-1", criterion: "User can reset via email", testCommand: "npm test -- reset", status: "unverified" }
              ],
              moduleProfileId: "profile-web"
            }
          }
        ]
      }
    });

    await persistAndMaybeApplyPatchProposal(projectRoot, "run-propose-checks", output);
    const proposals = await listPatchProposals(projectRoot);
    const bundle = await applyPatchProposal(projectRoot, proposals[0]!.artifact.id, [
      { operationIndex: 0, decision: "accepted" }
    ]);

    const node = bundle.flows[0]?.nodes.find((item) => item.id === "node-with-checks");
    expect(node?.acceptanceChecks).toHaveLength(1);
    expect(node?.acceptanceChecks[0]).toMatchObject({
      id: "chk-1",
      criterion: "User can reset via email",
      testCommand: "npm test -- reset",
      status: "unverified"
    });
    expect(node?.moduleProfileId).toBe("profile-web");
  });

  it("auto-resolves project convention file proposals", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "archicode-file-proposal-test-"));
    const bundle = await ensureProject(projectRoot);
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      patchReviewMode: "manual"
    });

    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        summary: "Suggest durable project agent instructions.",
        operations: [
          {
            kind: "propose-project-file",
            path: "AGENTS.md",
            mode: "create",
            content: "# Agent Instructions\n\n- Respect the ArchiCode graph before changing code.\n- Run the configured verification command before finishing.\n",
            reason: "Missing project-local instructions for future agent runs."
          }
        ]
      }
    });

    const persisted = await persistAndMaybeApplyPatchProposal(projectRoot, "run-agents", output);
    const proposals = await listPatchProposals(projectRoot);

    expect(persisted?.autoApplied).toBe(true);
    expect(persisted?.pendingReview).toBe(false);
    expect(proposals[0]?.artifact.status).toBe("applied");
    await expect(readFile(path.join(projectRoot, "AGENTS.md"), "utf8")).resolves.toContain("Respect the ArchiCode graph");
  });

  it("auto-applies safe source scaffold proposals when code review is automatic", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "archicode-source-auto-proposal-test-"));
    const bundle = await ensureProject(projectRoot);
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      codeReviewMode: "auto-apply",
      patchReviewMode: "auto"
    });

    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        summary: "Create a minimal app scaffold.",
        operations: [
          {
            kind: "propose-source-file",
            path: "package.json",
            action: "create",
            content: "{\n  \"name\": \"demo-app\"\n}\n",
            reason: "Create package metadata."
          },
          {
            kind: "propose-source-file",
            path: "vite.config.ts",
            action: "create",
            content: "export default {}\n",
            reason: "Create app build config."
          }
        ]
      }
    });

    const persisted = await persistAndMaybeApplyPatchProposal(projectRoot, "run-source-auto", output);
    const proposals = await listPatchProposals(projectRoot);

    expect(persisted?.autoApplied).toBe(true);
    expect(persisted?.pendingReview).toBe(false);
    expect(proposals[0]?.artifact.status).toBe("applied");
    await expect(readFile(path.join(projectRoot, "package.json"), "utf8")).resolves.toContain("demo-app");
    await expect(readFile(path.join(projectRoot, "vite.config.ts"), "utf8")).resolves.toContain("export default");
  });

  it("auto-applies run target profile proposals", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "archicode-run-profile-proposal-test-"));
    await ensureProject(projectRoot);

    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        summary: "Add a custom module run target.",
        operations: [
          {
            kind: "propose-run-profile",
            mode: "create",
            reason: "The project has a separate docs module with its own dev command.",
            profile: {
              id: "docs-local-browser",
              label: "Docs Browser",
              kind: "web",
              targetRequired: false,
              diagnosticCommands: [],
              recoveryCommands: [],
              retryAfterRecovery: true,
              runCommand: "npm run docs:dev",
              readyPattern: "localhost|127\\.0\\.0\\.1",
              timeoutSeconds: 120
            }
          }
        ]
      }
    });

    const persisted = await persistAndMaybeApplyPatchProposal(projectRoot, "run-profile-proposal", output);
    const bundle = await loadProject(projectRoot);

    expect(persisted?.autoApplied).toBe(true);
    expect(bundle.project.settings.runTargetProfiles.find((profile) => profile.id === "docs-local-browser")?.label).toBe("Docs Browser");
  });

  it("lists and applies accepted patch operations", async () => {
    const { projectRoot, artifact } = await createProjectWithProposal("unlocked");

    const proposals = await listPatchProposals(projectRoot);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.artifact.id).toBe(artifact.id);

    const bundle = await applyPatchProposal(projectRoot, artifact.id, [
      { operationIndex: 0, decision: "accepted" }
    ]);
    const node = bundle.flows[0]?.nodes.find((item) => item.id === "node-project");

    expect(node?.description).toBe("Updated by unlocked patch");
    expect((await listPatchProposals(projectRoot))[0]?.artifact.status).toBe("applied");
  });

  it("records a failed result when a patch tries to change an approved locked node", async () => {
    const { projectRoot, artifact } = await createProjectWithProposal("locked");

    await applyPatchProposal(projectRoot, artifact.id, [
      { operationIndex: 0, decision: "accepted" }
    ]);
    const proposals = await listPatchProposals(projectRoot);
    const review = proposals[0]?.review;

    expect(review?.results[0]?.status).toBe("failed");
    expect(review?.results[0]?.message).toMatch(/approved and locked/);
    expect(proposals[0]?.artifact.status).toBe("partially-applied");
  });
});
