import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { refreshEdgeEvidenceFreshness } from "../src/main/storage/projectStore";
import { reconcileFlowEvidence } from "../src/main/importer/evidenceRefresh";
import { createSeedProject } from "../src/shared/fixtures";
import { flowSchema } from "../src/shared/schema";
import { flowFromDisk, flowToDisk, projectStatePath, writeJson } from "../src/main/storage/persistence";
import { hydrateGraphEvidenceLocalState, rememberGraphEvidenceForFlows, rememberGraphEvidenceLocalState } from "../src/main/storage/graphEvidenceLocalState";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("graph relationship evidence", () => {
  it("marks imported evidence stale when one of its source files changed after analysis", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archicode-evidence-"));
    roots.push(root);
    await writeFile(path.join(root, "source.ts"), "export const value = 1;\n", "utf8");
    const { flow } = createSeedProject(root);
    const evidenceFlow = {
      ...flow,
      edges: [{
        ...flow.edges[0],
        evidence: {
          origin: "extracted" as const,
          confidence: 1,
          relationKinds: ["dependency"],
          locations: [{ path: "source.ts", line: 1 }],
          checkedAt: "2000-01-01T00:00:00.000Z",
          verification: "verified" as const,
          freshness: "current" as const
        }
      }]
    };

    const [refreshed] = await refreshEdgeEvidenceFreshness(root, [evidenceFlow]);

    expect(refreshed.edges[0].evidence?.freshness).toBe("stale");
  });

  it("re-verifies current relationships and conservatively retains unsupported edges", () => {
    const { flow } = createSeedProject("/tmp/evidence-refresh");
    const [source, target] = flow.nodes;
    expect(source && target).toBeTruthy();
    const scoped = flowSchema.parse({
      ...flow,
      nodes: [
        { ...source, implementationScope: { source: "codebase-importer", analyzerVersion: 1, checkedAt: "2026-01-01T00:00:00.000Z", claims: [{ relation: "own", kind: "file", path: "src/a.ts" }] } },
        { ...target, implementationScope: { source: "codebase-importer", analyzerVersion: 1, checkedAt: "2026-01-01T00:00:00.000Z", claims: [{ relation: "own", kind: "file", path: "src/b.ts" }] } }
      ],
      edges: [{
        id: "edge-a-b",
        source: source.id,
        target: target.id,
        evidence: {
          origin: "extracted",
          confidence: 1,
          relationKinds: ["dependency"],
          locations: [{ path: "src/a.ts", line: 1 }],
          checkedAt: "2026-01-01T00:00:00.000Z",
          verification: "verified",
          freshness: "stale"
        }
      }]
    });
    const scan = {
      files: [
        { relPath: "src/a.ts", ext: ".ts", sizeBytes: 20, language: "typescript" as const },
        { relPath: "src/b.ts", ext: ".ts", sizeBytes: 20, language: "typescript" as const }
      ],
      truncated: false,
      stats: { totalFiles: 2, byLanguage: { typescript: 2 } }
    };
    const checkedAt = "2026-07-13T10:00:00.000Z";
    const verified = reconcileFlowEvidence(scoped, scan, [{
      from: "src/a.ts",
      to: "src/b.ts",
      confidence: 1,
      relationKinds: ["dependency"],
      evidence: [{ line: 1, specifier: "./b" }]
    }], checkedAt);
    expect(verified.flow.edges[0].evidence).toMatchObject({ verification: "verified", freshness: "current", confidence: 1, checkedAt });
    expect(verified.flow.edges[0].evidence?.locations[0]).toEqual({ path: "src/a.ts", line: 1, fact: "./b" });

    const unsupported = reconcileFlowEvidence(scoped, scan, [], checkedAt);
    expect(unsupported.flow.edges[0].evidence).toMatchObject({ verification: "unresolved", freshness: "stale", confidence: 0 });
    expect(unsupported.flow.edges[0].label).toBe(scoped.edges[0].label);
  });

  it("keeps refresh timestamps local and stable shared flow JSON conflict-free", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archicode-local-evidence-"));
    roots.push(root);
    const { flow } = createSeedProject(root);
    const withEvidence = flowSchema.parse({
      ...flow,
      updatedAt: "2026-07-13T10:00:00.000Z",
      edges: [{
        ...flow.edges[0],
        evidence: {
          origin: "extracted",
          confidence: 1,
          relationKinds: ["dependency"],
          locations: [{ path: "src/a.ts", line: 1 }],
          analyzerVersion: 2,
          checkedAt: "2026-07-13T10:00:00.000Z",
          verification: "verified",
          freshness: "current"
        }
      }]
    });
    const disk = flowToDisk(withEvidence) as { edges: Record<string, { evidence: Record<string, unknown> }> };
    expect(disk.edges[withEvidence.edges[0].id].evidence).not.toHaveProperty("checkedAt");
    expect(disk.edges[withEvidence.edges[0].id].evidence).not.toHaveProperty("freshness");

    const flowPath = projectStatePath(root, "flows", `${flow.id}.json`);
    await writeJson(flowPath, withEvidence);
    const firstSharedBody = await readFile(flowPath, "utf8");
    await writeJson(flowPath, {
      ...withEvidence,
      updatedAt: "2026-07-13T11:00:00.000Z",
      edges: withEvidence.edges.map((edge) => ({ ...edge, evidence: edge.evidence ? { ...edge.evidence, checkedAt: "2026-07-13T11:00:00.000Z", freshness: "stale" as const } : undefined }))
    });
    expect(await readFile(flowPath, "utf8")).toBe(firstSharedBody);

    await rememberGraphEvidenceLocalState(root, [withEvidence]);
    const sharedRoundTrip = flowSchema.parse(flowFromDisk(JSON.parse(firstSharedBody)));
    const [hydrated] = await hydrateGraphEvidenceLocalState(root, [sharedRoundTrip]);
    expect(hydrated.edges[0].evidence).toMatchObject({ checkedAt: "2026-07-13T10:00:00.000Z", freshness: "current" });
  });

  it("persists several generated-flow observations in one batch without losing prior flows", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archicode-batch-evidence-"));
    roots.push(root);
    const evidence = (checkedAt: string, freshness: "current" | "stale") => ({
      origin: "extracted" as const,
      confidence: 1,
      relationKinds: ["dependency"],
      locations: [{ path: "src/a.ts", line: 1 }],
      checkedAt,
      verification: "verified" as const,
      freshness
    });
    await rememberGraphEvidenceForFlows(root, [{
      flowId: "flow-existing",
      edges: [{ id: "edge-existing", evidence: evidence("2026-07-13T09:00:00.000Z", "current") }]
    }]);
    await rememberGraphEvidenceForFlows(root, [
      { flowId: "flow-a", edges: [{ id: "edge-a", evidence: evidence("2026-07-13T10:00:00.000Z", "current") }] },
      { flowId: "flow-b", edges: [{ id: "edge-b", evidence: evidence("2026-07-13T11:00:00.000Z", "stale") }] }
    ]);

    const hydrate = (flowId: string, edgeId: string) => flowSchema.parse({
      ...createSeedProject(root).flow,
      id: flowId,
      edges: [{ ...createSeedProject(root).flow.edges[0], id: edgeId, evidence: evidence("2020-01-01T00:00:00.000Z", "stale") }]
    });
    const hydrated = await hydrateGraphEvidenceLocalState(root, [
      hydrate("flow-existing", "edge-existing"),
      hydrate("flow-a", "edge-a"),
      hydrate("flow-b", "edge-b")
    ]);
    expect(hydrated.map((flow) => flow.edges[0].evidence?.checkedAt)).toEqual([
      "2026-07-13T09:00:00.000Z",
      "2026-07-13T10:00:00.000Z",
      "2026-07-13T11:00:00.000Z"
    ]);
  });
});
