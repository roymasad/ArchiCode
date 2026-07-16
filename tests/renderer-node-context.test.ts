import { describe, expect, it } from "vitest";
import { flowSchema } from "../src/shared/schema";
import { nodeContextTargets } from "../src/renderer/src/utils/nodeContext";
import flowFixture from "../fixtures/sample-project/.archicode/flows/flow-main.json";

describe("2D node context tooltip", () => {
  it("prioritizes specific classes and symbols before broader files and directories", () => {
    const node = flowSchema.parse(flowFixture).nodes[0]!;
    const targets = nodeContextTargets({
      ...node,
      implementationScope: {
        claims: [
          { relation: "cover", kind: "directory", path: "src" },
          { relation: "own", kind: "file", path: "src/app.ts" },
          { relation: "own", kind: "class", path: "src/app.ts", symbol: "Application" },
          { relation: "own", kind: "function", path: "src/start.ts", symbol: "start" }
        ]
      }
    });

    expect(targets).toEqual([
      { kind: "class", label: "Application", path: "src/app.ts" },
      { kind: "function", label: "start", path: "src/start.ts" },
      { kind: "file", label: "app.ts", path: "src/app.ts" }
    ]);
  });

  it("falls back to imported evidence paths for architecture lens concepts", () => {
    const node = flowSchema.parse(flowFixture).nodes[0]!;
    expect(nodeContextTargets({
      ...node,
      implementationScope: undefined,
      customProperties: { "Evidence paths": "src/features/create.ts, src/features/share.ts" }
    })).toEqual([
      { kind: "file", label: "create.ts", path: "src/features/create.ts" },
      { kind: "file", label: "share.ts", path: "src/features/share.ts" }
    ]);
  });
});
