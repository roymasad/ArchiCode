import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodexLocalArgs } from "../src/main/providers/localCli";
import { ensureProject, loadProject, updateProjectSettings } from "../src/main/storage/projectStore";
import { startAgentRun } from "../src/main/storage/runEngine";
import { createSeedProject } from "../src/shared/fixtures";

async function createFakeCodex(root: string): Promise<string> {
  const commandPath = path.join(root, "fake-codex.cjs");
  await writeFile(commandPath, `#!/usr/bin/env node
const fs = require("fs");
const outIndex = process.argv.indexOf("--output-last-message");
if (outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], "Planning complete.", "utf8");
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`, "utf8");
  await chmod(commandPath, 0o755);
  return commandPath;
}

describe("web search controls", () => {
  it("defaults web search provider to native", () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.webSearch.provider;
    expect(provider).toBe("native");
  });

  it("passes Codex Local web-search controls as global flags before exec", () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers.find((item) => item.kind === "codex-local")!;
    const disabled = buildCodexLocalArgs(provider, { projectRoot: "/tmp/archicode", webSearchEnabled: false }, "/tmp/out.txt");
    const enabled = buildCodexLocalArgs(provider, { projectRoot: "/tmp/archicode", webSearchEnabled: true }, "/tmp/out.txt");

    expect(disabled).toContain("--config");
    expect(disabled).toContain("web_search=\"disabled\"");
    expect(disabled).not.toContain("--search");
    expect(enabled).toContain("--search");
    expect(enabled.indexOf("--search")).toBeLessThan(enabled.indexOf("exec"));
  });

  it("records web search as allowed by default", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-web-denied-"));
    const command = await createFakeCodex(root);
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command }
        : { ...provider, enabled: false })
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "codex-local",
      promptSummary: "Review without web"
    });
    const run = (await loadProject(root)).runs.find((item) => item.id === runId);

    expect(run?.webSearch?.decision).toBe("allowed");
  });

  it("records web search as denied when disabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-web-allowed-"));
    const command = await createFakeCodex(root);
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) => provider.id === "codex-local"
        ? { ...provider, enabled: true, localCommand: command }
        : { ...provider, enabled: false }),
      webSearch: {
        ...bundle.project.settings.webSearch,
        enabled: false
      }
    });

    const { runId } = await startAgentRun({
      projectRoot: root,
      flowId: "flow-main",
      providerId: "codex-local",
      promptSummary: "Review with web"
    });
    const run = (await loadProject(root)).runs.find((item) => item.id === runId);

    expect(run?.webSearch?.decision).toBe("denied");
  });
});
