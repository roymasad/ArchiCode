import { describe, expect, it } from "vitest";
import { extractArchicodePatch } from "../src/shared/patchExtraction";
import { extractArchicodeResearch } from "../src/shared/researchExtraction";

describe("archicode patch extraction", () => {
  it("extracts a fenced archicodePatch wrapper", () => {
    const output = [
      "Here is the proposal:",
      "```json",
      JSON.stringify({
        archicodePatch: {
          schemaVersion: 1,
          summary: "Ask a question.",
          operations: [
            {
              kind: "add-note",
              note: {
                flowId: "flow-main",
                nodeId: "node-orchestrator",
                kind: "llm-question",
                author: "llm",
                body: "Which runtime should this use?",
                resolved: false
              }
            }
          ]
        }
      }),
      "```"
    ].join("\n");

    const result = extractArchicodePatch(output, "run-test");
    expect(result.proposal?.runId).toBe("run-test");
    expect(result.proposal?.operations).toHaveLength(1);
  });

  it("extracts a direct patch object from surrounding prose", () => {
    const output = `Use this JSON next:
{
  "schemaVersion": 1,
  "summary": "Update node metadata.",
  "operations": []
}
Thanks.`;

    const result = extractArchicodePatch(output, "run-direct");
    expect(result.proposal?.summary).toBe("Update node metadata.");
  });

  it("normalizes direct Codex source proposals with simplified node updates", () => {
    const output = `No local files were edited, so here are machine-applicable proposals.
\`\`\`json
{
  "schemaVersion": 1,
  "runId": "run-old",
  "summary": "Create a starter app.",
  "operations": [
    {
      "kind": "propose-project-file",
      "path": ".gitignore",
      "action": "create",
      "content": "node_modules/\\n",
      "reason": "Ignore dependencies."
    },
    {
      "kind": "propose-source-file",
      "path": "src/main.ts",
      "action": "create",
      "content": "console.log('hello')\\n",
      "nodeId": "node-landing-page",
      "reason": "Create the app entry."
    },
    {
      "kind": "update-node",
      "nodeId": "node-landing-page",
      "flags": ["changed", "needs-attention"],
      "reason": "Implementation awaits review."
    }
  ]
}
\`\`\``;

    const result = extractArchicodePatch(output, "run-codex");

    expect(result.errors).toHaveLength(0);
    expect(result.proposal?.runId).toBe("run-codex");
    expect(result.proposal?.operations[0]).toMatchObject({ kind: "propose-project-file", mode: "create" });
    expect(result.proposal?.operations[1]).toMatchObject({ kind: "propose-source-file", path: "src/main.ts" });
    expect(result.proposal?.operations[2]).toMatchObject({
      kind: "update-node",
      flowId: "flow-main",
      patch: { id: "node-landing-page", flags: ["changed", "needs-attention"] }
    });
  });

  it("extracts source proposals whose file contents contain markdown fences", () => {
    const output = [
      "```json",
      JSON.stringify({
        archicodePatch: {
          schemaVersion: 1,
          summary: "Create a README and app file.",
          operations: [
            {
              kind: "propose-source-file",
              path: "README.md",
              action: "create",
              content: "# App\n\n```bash\nnpm install\nnpm run dev\n```\n",
              testIntent: null
            },
            {
              kind: "propose-source-file",
              path: "src/main.ts",
              action: "create",
              content: "console.log('ready')\n",
              testIntent: null
            }
          ]
        }
      }, null, 2),
      "```"
    ].join("\n");

    const result = extractArchicodePatch(output, "run-fenced-content");

    expect(result.errors).toHaveLength(0);
    expect(result.proposal?.operations).toHaveLength(2);
    expect(result.proposal?.operations[0]).toMatchObject({
      kind: "propose-source-file",
      path: "README.md",
      content: expect.stringContaining("```bash")
    });
  });

  it("normalizes question notes with operation-level node targets", () => {
    const output = `Decision: ask_questions

\`\`\`json
{
  "archicodePatch": {
    "schemaVersion": 1,
    "summary": "Ask before scaffolding.",
    "operations": [
      {
        "kind": "add-note",
        "nodeId": "node-architecture",
        "note": {
          "kind": "llm-question",
          "author": "llm",
          "body": "Which stack should this workspace actually scaffold?",
          "category": "question",
          "priority": "high"
        }
      }
    ]
  }
}
\`\`\``;

    const result = extractArchicodePatch(output, "run-questions");

    expect(result.errors).toHaveLength(0);
    expect(result.proposal?.operations[0]).toMatchObject({
      kind: "add-note",
      note: {
        flowId: "flow-main",
        nodeId: "node-architecture",
        kind: "llm-question",
        author: "llm",
        category: "note",
        priority: "high",
        body: "Which stack should this workspace actually scaffold?"
      }
    });
  });

  it("normalizes flattened note fields into nested add-note notes", () => {
    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        summary: "Record a note.",
        operations: [
          {
            kind: "add-note",
            nodeId: "node-architecture",
            noteKind: "system-note",
            author: "llm",
            category: "note",
            priority: "normal",
            body: "Coding notes belong outside source changes."
          }
        ]
      }
    });

    const result = extractArchicodePatch(output, "run-flattened-note");

    expect(result.errors).toHaveLength(0);
    expect(result.proposal?.operations[0]).toMatchObject({
      kind: "add-note",
      note: {
        flowId: "flow-main",
        nodeId: "node-architecture",
        kind: "system-note",
        author: "llm",
        category: "note",
        priority: "normal",
        body: "Coding notes belong outside source changes."
      }
    });
  });

  it("accepts richer planning run summary fields for user-facing plans", () => {
    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        runId: "run-plan-shape",
        summary: "Proceed with a structured implementation plan.",
        runSummary: {
          goal: "Deliver the first-pass marketing site experience.",
          approach: "Scaffold the app shell, then build the landing and contact routes in separate slices.",
          assumptions: ["Vue 3 remains the chosen stack."],
          verificationPlan: "Run npm run build after the final slice.",
          risks: ["Navigation changes touch shared layout."],
          implementationTasks: [
            {
              id: "task-1",
              title: "Scaffold the shell",
              summary: "Create the base app shell.",
              batchBudget: 1
            }
          ]
        },
        operations: []
      }
    });

    const result = extractArchicodePatch(output, "run-plan-shape");

    expect(result.errors).toHaveLength(0);
    expect(result.proposal?.runSummary).toMatchObject({
      goal: "Deliver the first-pass marketing site experience.",
      approach: "Scaffold the app shell, then build the landing and contact routes in separate slices.",
      assumptions: ["Vue 3 remains the chosen stack."],
      verificationPlan: "Run npm run build after the final slice.",
      risks: ["Navigation changes touch shared layout."]
    });
  });

  it("keeps coding handoffs source-only and quarantines non-source metadata", () => {
    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        summary: "Create a source file with noisy metadata.",
        operations: [
          {
            kind: "propose-project-file",
            path: "README.md",
            mode: "create",
            content: "# App\n",
            reason: "This is a real project file and should be source-file."
          },
          {
            kind: "propose-source-file",
            path: "src/app.ts",
            action: "create",
            content: "export const app = true;\n",
            reason: "Implement the app."
          },
          {
            kind: "add-note",
            nodeId: "node-architecture",
            noteKind: "system-note",
            author: "llm",
            category: "note",
            priority: "normal",
            body: "Run-level note that should not become graph state."
          }
        ]
      }
    });

    const result = extractArchicodePatch(output, "run-source-only", { phase: "coding" });

    expect(result.errors).toHaveLength(0);
    expect(result.proposal?.operations).toEqual([
      expect.objectContaining({
        kind: "propose-source-file",
        path: "src/app.ts"
      })
    ]);
    expect(result.quarantinedOperations).toHaveLength(2);
    expect(result.warnings).toEqual([
      expect.stringContaining("operation 0 propose-project-file quarantined"),
      expect.stringContaining("operation 2 add-note quarantined")
    ]);
  });

  it("accepts direct coding handoffs with run summary notes as a list", () => {
    const output = [
      "```json",
      JSON.stringify({
        schemaVersion: 1,
        runId: "run-old",
        summary: "Create source files.",
        runSummary: {
          implementationStatus: "complete",
          notes: [
            "Created the app shell.",
            "Verification should run after applying proposals."
          ]
        },
        operations: [
          {
            kind: "propose-source-file",
            path: "src/main.ts",
            action: "create",
            content: "console.log('ready')\n",
            reason: "Implement the entrypoint."
          }
        ]
      }),
      "```"
    ].join("\n");

    const result = extractArchicodePatch(output, "run-notes-list", { phase: "coding" });

    expect(result.errors).toHaveLength(0);
    expect(result.proposal?.runId).toBe("run-notes-list");
    expect(result.proposal?.runSummary?.notes).toBe("Created the app shell.\nVerification should run after applying proposals.");
    expect(result.proposal?.operations[0]).toMatchObject({
      kind: "propose-source-file",
      path: "src/main.ts"
    });
  });

  it("reports coding handoffs with no usable source-file operations", () => {
    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        summary: "Only metadata.",
        operations: [
          {
            kind: "add-note",
            nodeId: "node-architecture",
            noteKind: "system-note",
            author: "llm",
            category: "note",
            priority: "normal",
            body: "No source files here."
          }
        ]
      }
    });

    const result = extractArchicodePatch(output, "run-no-source", { phase: "coding" });

    expect(result.proposal).toBeNull();
    expect(result.errors.join(" ")).toContain("did not include usable propose-source-file operations");
  });

  it("accepts a coding handoff with no operations that explicitly signals completion", () => {
    const output = JSON.stringify({
      archicodePatch: {
        schemaVersion: 1,
        summary: "All tasks already implemented in earlier batches; build passes.",
        runSummary: {
          implementationStatus: "complete",
          notes: "AboutPage.vue and ContactPage.vue were built in prior batches. npm run build passes."
        },
        operations: []
      }
    });

    const result = extractArchicodePatch(output, "run-complete-noop", { phase: "coding" });

    expect(result.proposal).not.toBeNull();
    expect(result.proposal?.runSummary?.implementationStatus).toBe("complete");
    expect(result.proposal?.operations).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

describe("archicode research extraction", () => {
  it("extracts a local-provider canvas action separately from graph changes", () => {
    const result = extractArchicodeResearch(JSON.stringify({
      archicodeResearch: {
        answer: "Focused the API group.",
        canvasAction: {
          flowId: "flow-main",
          subflowId: null,
          groupIds: ["group-api"],
          selection: "replace",
          viewport: { mode: "fit", padding: 0.2, maxZoom: 1.05 }
        }
      }
    }));

    expect(result.errors).toEqual([]);
    expect(result.response?.canvasAction).toMatchObject({
      flowId: "flow-main",
      groupIds: ["group-api"],
      selection: "replace",
      viewport: { mode: "fit" }
    });
    expect(result.response?.changeSet).toBeUndefined();
  });

  it("normalizes common edge aliases in graph change sets", () => {
    const output = JSON.stringify({
      archicodeResearch: {
        answer: "Mapped the codebase.",
        summary: "Initial map.",
        changeSet: {
          summary: "Add map",
          operations: [
            {
              kind: "create-node",
              flowId: "flow-main",
              node: {
                id: "node-ui",
                type: "container",
                title: "UI",
                description: "React interface for the app.",
                technologies: "React, TypeScript",
                criteria: ["Routes render", "State updates are visible"]
              }
            },
            {
              kind: "create-edge",
              flowId: "flow-main",
              edge: {
                id: "edge-ui-main",
                sourceId: "node-ui",
                targetId: "node-main",
                label: "calls"
              }
            },
            {
              kind: "create-subflow",
              flowId: "flow-main",
              subflow: {
                id: "subflow-ui",
                title: "UI Layer"
              }
            },
            {
              kind: "link-node-subflow",
              flowId: "flow-main",
              node: { id: "node-ui" },
              detailFlowId: "subflow-ui"
            },
            {
              kind: "create-edge",
              flowId: "flow-main",
              from: "node-main",
              to: "node-storage",
              edge: {
                label: "persists"
              }
            },
            {
              kind: "update-subflow",
              flowId: "flow-main",
              detailFlowId: "subflow-ui",
              title: "Renamed UI Layer"
            }
          ]
        }
      }
    });

    const result = extractArchicodeResearch(output);

    expect(result.errors).toEqual([]);
    expect(result.response?.changeSet?.operations[0]).toMatchObject({
      kind: "create-node",
      node: {
        description: "React interface for the app.",
        techStack: ["React", "TypeScript"],
        acceptanceCriteria: ["Routes render", "State updates are visible"]
      }
    });
    expect(result.response?.changeSet?.operations[1]).toMatchObject({
      kind: "create-edge",
      edge: {
        source: "node-ui",
        target: "node-main"
      }
    });
    expect(result.response?.changeSet?.operations[2]).toMatchObject({
      kind: "create-subflow",
      subflow: {
        name: "UI Layer"
      }
    });
    expect(result.response?.changeSet?.operations[3]).toMatchObject({
      kind: "link-node-subflow",
      nodeId: "node-ui",
      subflowId: "subflow-ui"
    });
    expect(result.response?.changeSet?.operations[4]).toMatchObject({
      kind: "create-edge",
      edge: {
        source: "node-main",
        target: "node-storage"
      }
    });
    expect(result.response?.changeSet?.operations[5]).toMatchObject({
      kind: "update-subflow",
      subflowId: "subflow-ui",
      patch: {
        name: "Renamed UI Layer"
      }
    });
  });

  it("salvages research run guidance when evidence contains graph ids", () => {
    const output = `\`\`\`json
{
  "archicodeResearch": {
    "answer": "I can queue an AI Implement run.",
    "summary": "Prepared implementation guidance.",
    "changeSet": {
      "summary": "Queue AI Implement",
      "operations": [
        {
          "kind": "start-agent-run",
          "flowId": "flow-main",
          "nodeId": "node-project",
          "providerId": "openai-compatible",
          "promptSummary": "Implement the initial website.",
          "allowShell": false,
          "reusableApproval": false,
          "guidance": {
            "text": "Use a red theme.",
            "evidence": ["flow-main", "node-project", "node-landing-page"]
          }
        }
      ]
    }
  }
}
\`\`\``;

    const result = extractArchicodeResearch(output);
    const operation = result.response?.changeSet?.operations[0];

    expect(result.errors).toEqual([]);
    expect(operation).toMatchObject({
      kind: "start-agent-run",
      guidance: {
        evidence: []
      }
    });
    expect(operation && "guidance" in operation ? operation.guidance?.text : "").toContain("Use a red theme.");
    expect(operation && "guidance" in operation ? operation.guidance?.text : "").toContain("node-landing-page");
  });

  it("normalizes create-node title aliases and root-level node fields", () => {
    const output = JSON.stringify({
      archicodeResearch: {
        answer: "Mapped the codebase.",
        changeSet: {
          summary: "Add map",
          operations: [
            {
              kind: "create-node",
              flowId: "flow-main",
              id: "node-runtime",
              nodeType: "container",
              name: "Runtime Host",
              description: "Loads the browser runtime and coordinates startup.",
              stack: ["TypeScript", "Vite"],
              expectedBehavior: ["Runtime starts without console errors"],
              dependsOn: "node-assets",
              detailFlowId: "subflow-runtime"
            },
            {
              kind: "create-node",
              flowId: "flow-main",
              node: {
                id: "node-assets",
                label: "Static Assets",
                responsibility: "Provides bundled files consumed by the runtime.",
                visual: { shape: "round-rect" },
                frameworks: "Vite",
                criteria: "Assets are present after build"
              }
            }
          ]
        }
      }
    });

    const result = extractArchicodeResearch(output);

    expect(result.errors).toEqual([]);
    expect(result.response?.changeSet?.operations[0]).toMatchObject({
      kind: "create-node",
      node: {
        id: "node-runtime",
        type: "container",
        title: "Runtime Host",
        description: "Loads the browser runtime and coordinates startup.",
        techStack: ["TypeScript", "Vite"],
        acceptanceCriteria: ["Runtime starts without console errors"],
        subflowId: "subflow-runtime"
      }
    });
    expect(result.response?.changeSet?.operations[1]).toMatchObject({
      kind: "create-node",
      node: {
        title: "Static Assets",
        description: "Provides bundled files consumed by the runtime.",
        visual: {},
        techStack: ["Vite"],
        acceptanceCriteria: ["Assets are present after build"]
      }
    });
  });
});
