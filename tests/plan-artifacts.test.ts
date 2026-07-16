import { describe, expect, it } from "vitest";
import { formatPlanArtifactText, planArtifactDerivedDisplay } from "../src/renderer/src/utils/planArtifacts";

describe("plan artifact formatting", () => {
  it("renders stored plan artifacts as readable plan text", () => {
    const artifactText = JSON.stringify({
      id: "plan-1",
      type: "plan",
      title: "Implement contact pages",
      summary: "Implement the Contact Us and Portfolio pages.",
      providerSummary: "Proceed with two source slices.",
      plan: {
        intent: "Implement the Contact Us and Portfolio pages.",
        scope: {
          flowId: "flow-main",
          nodeId: "node-pages",
          providerId: "codex-local"
        },
        assumptions: [
          "Vue router is already configured.",
          "The app should keep the existing navigation layout."
        ],
        commandsNeeded: ["npm run build"],
        testsExpected: ["npm run test"],
        allowedRoots: ["/project/src"],
        risks: ["Navigation changes can affect multiple routes."],
        rollbackNotes: "Revert the generated source diff artifact if the routes regress."
      },
      text: [
        "Decision: proceed",
        "```json",
        JSON.stringify({
          archicodePatch: {
            summary: "Create ContactPage.vue, PortfolioPage.vue, and update the nav.",
            runSummary: {
              goal: "Implement the Contact Us and Portfolio pages within the existing app shell.",
              approach: "Add each route as its own slice, then update shared navigation once both pages exist.",
              assumptions: ["Vue router is already configured."],
              verificationPlan: "Use npm run test after route work and npm run build before finishing.",
              risks: ["Navigation changes can affect multiple routes."],
              implementationTasks: [
                {
                  title: "Create ContactPage.vue",
                  summary: "Add the contact page route component.",
                  batchBudget: 1,
                  verificationCommand: "npm run test"
                },
                {
                  title: "Create PortfolioPage.vue",
                  summary: "Add the portfolio page route component.",
                  batchBudget: 1,
                  lightVerificationCommand: "npm run test",
                  verificationCommand: "npm run build"
                }
              ]
            }
          }
        }),
        "```"
      ].join("\n")
    });

    const formatted = formatPlanArtifactText(artifactText);

    expect(formatted).toContain("Create ContactPage.vue, PortfolioPage.vue, and update the nav.");
    expect(formatted).toContain("Decision: proceed");
    expect(formatted).toContain("Goal");
    expect(formatted).toContain("Approach");
    expect(formatted).toContain("Key Assumptions");
    expect(formatted).toContain("Implementation Steps");
    expect(formatted).toContain("Verification");
    expect(formatted).toContain("Risks");
    expect(formatted).toContain("1. Create ContactPage.vue");
    expect(formatted).toContain("Batch budget: 1");
    expect(formatted).toContain("Planning Prompt");
    expect(formatted).toContain("Scope");
    expect(formatted).toContain("Rollback");
    expect(formatted).not.toContain("\"archicodePatch\"");
  });

  it("renders prompt-only plan artifacts as planning prompts instead of fake plans", () => {
    const artifactText = JSON.stringify({
      id: "plan-2",
      type: "plan",
      title: "Prompt only",
      summary: "Plan from the whole project using node stages and acceptance criteria.",
      promptSummary: "Plan from the whole project using node stages and acceptance criteria.",
      plan: {
        intent: "Plan from the whole project using node stages and acceptance criteria.",
        scope: {
          flowId: "flow-main",
          providerId: "openai-compatible"
        },
        commandsNeeded: ["npm run build"],
        testsExpected: ["npm run build"]
      }
    });

    const formatted = formatPlanArtifactText(artifactText);

    expect(formatted).toContain("Planning prompt");
    expect(formatted).toContain("Plan from the whole project using node stages and acceptance criteria.");
    expect(formatted).not.toContain("Implementation Tasks");
    expect(formatted).not.toContain("\"archicodePatch\"");
  });

  it("derives generated-plan labels from the stored plan artifact payload", () => {
    const artifact = {
      id: "plan-legacy",
      type: "plan" as const,
      title: "Legacy plan",
      path: ".archicode/artifacts/run-legacy-plan.json",
      summary: "Plan from the whole project using node stages and acceptance criteria."
    };
    const artifactText = JSON.stringify({
      ...artifact,
      providerSummary: "**Decision: proceed** I have enough context.",
      text: [
        "**Decision: proceed**",
        "```json",
        JSON.stringify({
          archicodePatch: {
            summary: "Proceed with a fast 5-task scaffold of a two-page marketing site.",
            runSummary: {
              implementationTasks: [
                { title: "Scaffold foundation", summary: "Create the project shell.", batchBudget: 1 }
              ]
            }
          }
        }),
        "```"
      ].join("\n")
    });

    const derived = planArtifactDerivedDisplay(artifact, artifactText);

    expect(derived.badgeLabel).toBe("plan");
    expect(derived.listLabel).toBe("Proceed with a fast 5-task scaffold of a two-page marketing site.");
  });
});
