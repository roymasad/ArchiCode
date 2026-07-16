import { describe, expect, it } from "vitest";
import { researchChangeSetCategory } from "../src/shared/researchChangeSetSemantics";

describe("research change-set semantics", () => {
  it("distinguishes queue submissions from graph edits and mixed changes", () => {
    expect(researchChangeSetCategory([{ kind: "start-agent-run" }])).toBe("queue");
    expect(researchChangeSetCategory([{ kind: "retry-run" }, { kind: "start-debugging-run" }])).toBe("queue");
    expect(researchChangeSetCategory([{ kind: "create-node" }, { kind: "create-edge" }])).toBe("graph");
    expect(researchChangeSetCategory([{ kind: "create-node" }, { kind: "start-agent-run" }])).toBe("change");
    expect(researchChangeSetCategory([{ kind: "run-acceptance-checks" }])).toBe("change");
  });
});
