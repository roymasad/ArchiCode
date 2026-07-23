import { describe, expect, it } from "vitest";
import { changeSetResultReportPresentation } from "../src/shared/researchResultPresentation";

describe("research result report presentation", () => {
  it("keeps the assistant outcome narrative visible above compact operation details", () => {
    const presentation = changeSetResultReportPresentation([
      'Graph review complete for "Add Header and Footer".',
      "2 applied, 2 rejected, 0 failed.",
      "Outcome: Applied: Created node Header; Created edge Landing Page -> Header. Not applied by your selection: Create node Footer; Create edge Landing Page -> Footer. I kept this exact review outcome and did not generate another proposal.",
      "Applied: Created node Header.",
      "Rejected: Create node Footer.",
      "Applied: Created edge Landing Page -> Header.",
      "Rejected: Create edge Landing Page -> Footer.",
      "No automatic retry was created."
    ].join("\n\n"));

    expect(presentation).toMatchObject({
      title: "Graph review complete",
      summary: "2 applied, 2 rejected, 0 failed.",
      operationCount: 4,
      tone: "warning"
    });
    expect(presentation?.narrative).toContain("Applied: Created node Header");
    expect(presentation?.narrative).toContain("did not generate another proposal");
    expect(presentation?.details).toContain("Rejected: Create node Footer");
  });
});
