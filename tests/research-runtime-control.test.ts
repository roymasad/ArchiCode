import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyResearchOperation } from "../src/main/research/graphOps";
import { researchToolDiscoverRunTargets, researchToolListRuntimeServices } from "../src/main/research/inspectionTools";
import { ensureProject, updateProjectSettings } from "../src/main/storage/projectStore";
import { listRuntimeServices, startRuntimeService, stopRuntimeService } from "../src/main/storage/runtimeServices";

describe("Archi chat runtime control", () => {
  it("inspects profiles and targets, then applies reviewed stop and restart actions", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "archicode-research-runtime-"));
    const bundle = await ensureProject(projectRoot);
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

    const started = await startRuntimeService({ projectRoot, profileId: "chat-runtime" });
    const service = started.find((item) => item.profileId === "chat-runtime")!;
    const live = await researchToolListRuntimeServices(projectRoot, { serviceId: service.id, maxLogs: 10 }) as {
      services: Array<{ id: string; status: string; targetId?: string }>;
    };
    expect(live.services[0]).toMatchObject({ id: service.id, status: "running", targetId: "desktop-1" });

    await expect(applyResearchOperation(projectRoot, { kind: "stop-runtime-service", serviceId: service.id }))
      .resolves.toContain("Stopped runtime service Chat Runtime");
    expect((await listRuntimeServices(projectRoot)).find((item) => item.id === service.id)?.status).toBe("stopped");

    await expect(applyResearchOperation(projectRoot, { kind: "restart-runtime-service", serviceId: service.id }))
      .resolves.toContain("Restarted runtime service Chat Runtime");
    const restarted = (await listRuntimeServices(projectRoot)).find((item) => item.profileId === "chat-runtime" && item.status === "running");
    expect(restarted).toBeDefined();

    await stopRuntimeService(projectRoot, restarted!.id);
  });
});
