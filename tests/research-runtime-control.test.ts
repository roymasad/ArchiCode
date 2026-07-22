import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { researchToolDiscoverRunTargets, researchToolListRuntimeServices, researchToolRestartRuntimeService, researchToolStartRuntimeService, researchToolStopRuntimeService } from "../src/main/research/inspectionTools";
import { ensureFixtureProject, loadProject, updateProjectSettings } from "../src/main/storage/projectStore";
import { listRuntimeServices, stopRuntimeService } from "../src/main/storage/runtimeServices";

describe("Archi chat runtime control", () => {
  it("directly starts, stops, and restarts exact runtime services without Activity runs", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-runtime-"));
    const bundle = await ensureFixtureProject(projectRoot);
    await updateProjectSettings(projectRoot, {
      ...bundle.project.settings,
      runTargetProfiles: [{
        id: "chat-runtime",
        label: "Chat Runtime",
        kind: "electron",
        discoverCommand: "echo 'desktop-1 • Desktop One'",
        targetPattern: "^(?<id>\\S+)\\s+•\\s+(?<label>.+)$",
        targetRequired: false,
        runCommand: "node -e \"console.log('chat-runtime-ready'); setInterval(() => {}, 1000)\"",
        runtimeReadyPattern: "chat-runtime-ready",
        diagnosticCommands: [],
        recoveryCommands: [],
        retryAfterRecovery: true,
        timeoutSeconds: 5
      }]
    });

    const initial = await researchToolListRuntimeServices(projectRoot, { maxLogs: 5 }) as {
      profiles: Array<{ id: string; canDiscoverTargets: boolean }>;
      services: unknown[];
    };
    const discovered = await researchToolDiscoverRunTargets(projectRoot, { profileId: "chat-runtime" }) as {
      targets: Array<{ id: string; label: string }>;
    };

    expect(initial.profiles).toContainEqual(expect.objectContaining({ id: "chat-runtime", canDiscoverTargets: true }));
    expect(initial.services).toEqual([]);
    expect(discovered.targets).toEqual([{ id: "desktop-1", label: "Desktop One" }]);

    const started = await researchToolStartRuntimeService(projectRoot, { profileId: "chat-runtime" }) as {
      action: string;
      direct: boolean;
      service: { id: string; profileId: string; status: string };
    };
    const service = (await listRuntimeServices(projectRoot)).find((item) => item.id === started.service.id)!;
    expect(started).toMatchObject({ action: "run-app", direct: true, service: { profileId: "chat-runtime", status: "running" } });
    expect((await loadProject(projectRoot)).runs.some((run) => run.runProfileId === "chat-runtime")).toBe(false);
    const live = await researchToolListRuntimeServices(projectRoot, { serviceId: service.id, maxLogs: 10 }) as {
      services: Array<{ id: string; status: string; targetId?: string }>;
    };
    expect(live.services[0]).toMatchObject({ id: service.id, status: "running", targetId: "desktop-1" });

    await expect(researchToolStopRuntimeService(projectRoot, { serviceId: service.id }))
      .resolves.toMatchObject({ action: "stop-run-app", direct: true, service: { status: "stopped" } });
    expect((await listRuntimeServices(projectRoot)).find((item) => item.id === service.id)?.status).toBe("stopped");

    await expect(researchToolRestartRuntimeService(projectRoot, { serviceId: service.id }))
      .resolves.toMatchObject({ action: "restart-run-app", direct: true, service: { status: "running" } });
    const restarted = (await listRuntimeServices(projectRoot)).find((item) => item.profileId === "chat-runtime" && item.status === "running");
    expect(restarted).toBeDefined();
    expect((await loadProject(projectRoot)).runs.some((run) => run.runProfileId === "chat-runtime")).toBe(false);

    await stopRuntimeService(projectRoot, restarted!.id);
  });
});
