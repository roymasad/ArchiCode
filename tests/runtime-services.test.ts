import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureProject, updateProjectSettings } from "../src/main/storage/projectStore";
import { listRuntimeServices, runtimeServiceSpawnOptions, shutdownRuntimeServices, startRuntimeService, stopRuntimeService, waitForRuntimeServiceReady } from "../src/main/storage/runtimeServices";
import { runtimeInsight } from "../src/shared/runtimeInsights";

async function waitForRuntimeUrl(root: string, serviceId: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const service = (await listRuntimeServices(root)).find((item) => item.id === serviceId);
    if (service?.url) return service.url;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}

describe("runtime services", () => {
  it("starts runtime commands hidden on Windows while preserving managed stdout pipes", () => {
    const options = runtimeServiceSpawnOptions("/tmp/project");

    expect(options.shell).toBe(true);
    expect(options.windowsHide).toBe(true);
    expect(options.detached).toBe(process.platform !== "win32");
  });

  it("stops ArchiCode-owned runtime processes during app shutdown", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-runtime-shutdown-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      runTargetProfiles: [{
        id: "owned-web",
        label: "Owned Web",
        kind: "web",
        runCommand: "node -e \"console.log('ready'); setInterval(() => {}, 1000)\"",
        runtimeReadyPattern: "ready",
        targetRequired: false,
        diagnosticCommands: [],
        recoveryCommands: [],
        retryAfterRecovery: true,
        timeoutSeconds: 5
      }]
    });

    const started = await startRuntimeService({ projectRoot: root, profileId: "owned-web" });
    const service = started.find((entry) => entry.profileId === "owned-web")!;
    expect(["starting", "running"]).toContain(service.status);

    await shutdownRuntimeServices();

    expect((await listRuntimeServices(root)).find((entry) => entry.id === service.id)?.status).toBe("stopped");
  });

  it("classifies meaningful runtime output for debugging", () => {
    const insight = runtimeInsight({
      id: "runtime-test",
      projectRoot: "/tmp/project",
      label: "Web",
      kind: "web",
      status: "running",
      command: "npm run dev",
      cwd: "/tmp/project",
      relativeCwd: "",
      ports: [],
      logs: [
        { at: "2026-06-25T10:00:00.000Z", stream: "stderr", text: "Error: listen EADDRINUSE: address already in use :::5173" }
      ]
    });

    expect(insight.tone).toBe("danger");
    expect(insight.label).toBe("Port conflict");
  });

  it("runs multiple module profiles concurrently and stops them independently", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-runtime-services-"));
    await mkdir(path.join(root, "apps", "web"), { recursive: true });
    await mkdir(path.join(root, "apps", "api"), { recursive: true });
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      runTargetProfiles: [
        {
          id: "web",
          label: "Web",
          kind: "web",
          cwd: "apps/web",
          runCommand: "node -e \"console.log('web ready'); setInterval(() => {}, 1000)\"",
          targetRequired: false,
          diagnosticCommands: [],
          recoveryCommands: [],
          retryAfterRecovery: true,
          timeoutSeconds: 90
        },
        {
          id: "api",
          label: "API",
          kind: "api",
          cwd: "apps/api",
          runCommand: "node -e \"console.log('api ready'); setInterval(() => {}, 1000)\"",
          targetRequired: false,
          diagnosticCommands: [],
          recoveryCommands: [],
          retryAfterRecovery: true,
          timeoutSeconds: 90
        }
      ]
    });

    let services = await startRuntimeService({ projectRoot: root, profileId: "web" });
    services = await startRuntimeService({ projectRoot: root, profileId: "api" });

    expect(services).toEqual(expect.arrayContaining([
      expect.objectContaining({ profileId: "web", status: "running", relativeCwd: "apps/web" }),
      expect.objectContaining({ profileId: "api", status: "running", relativeCwd: "apps/api" })
    ]));

    const web = services.find((service) => service.profileId === "web")!;
    services = await stopRuntimeService(root, web.id);

    expect(services.find((service) => service.profileId === "web")?.status).toBe("stopped");
    expect(services.find((service) => service.profileId === "api")?.status).toBe("running");

    const api = services.find((service) => service.profileId === "api")!;
    await stopRuntimeService(root, api.id);
  });

  it("rejects runtime profile cwd outside the project root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-runtime-cwd-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      runTargetProfiles: [
        {
          id: "bad",
          label: "Bad",
          kind: "generic",
          cwd: "../outside",
          runCommand: "node -e \"console.log('bad')\"",
          targetRequired: false,
          diagnosticCommands: [],
          recoveryCommands: [],
          retryAfterRecovery: true,
          timeoutSeconds: 90
        }
      ]
    });

    await expect(startRuntimeService({ projectRoot: root, profileId: "bad" })).rejects.toThrow(/escapes the project root/);
    await expect(listRuntimeServices(root)).resolves.toEqual([]);
  });

  it("runs setup before starting a runtime service", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-runtime-setup-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      runTargetProfiles: [
        {
          id: "api",
          label: "API",
          kind: "api",
          cwd: "",
          setupCommand: "node -e \"require('fs').writeFileSync('ready.txt', 'ready', 'utf8')\"",
          runCommand: "node -e \"const fs=require('fs'); if (!fs.existsSync('ready.txt')) process.exit(9); console.log('api ready'); setInterval(() => {}, 1000)\"",
          targetRequired: false,
          diagnosticCommands: [],
          recoveryCommands: [],
          retryAfterRecovery: true,
          timeoutSeconds: 90
        }
      ]
    });

    const services = await startRuntimeService({ projectRoot: root, profileId: "api" });
    const service = services.find((item) => item.profileId === "api")!;

    expect(service.status).toBe("running");
    await expect(readFile(path.join(root, "ready.txt"), "utf8")).resolves.toBe("ready");
    expect(service.logs.some((line) => line.text.includes("Running setup command"))).toBe(true);

    await stopRuntimeService(root, service.id);
  });

  it("discovers, launches, waits for, runs, and cleans up an owned target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-runtime-target-lifecycle-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      runTargetProfiles: [{
        id: "device-target",
        label: "Device Target",
        kind: "generic",
        discoverCommand: "node -e \"console.log('device-1 \\u2022 Device One \\u2022 Local \\u2022 generic')\"",
        targetPattern: "^\\s*(?<id>\\S+)\\s+\\u2022\\s+(?<label>[^\\u2022]+)\\s+\\u2022\\s+[^\\u2022]+\\s+\\u2022\\s+generic\\s*$",
        targetRequired: true,
        launchCommand: "node -e \"require('fs').writeFileSync('target-ready.txt','ready')\"",
        waitCommand: "node -e \"const fs=require('fs'); console.log(fs.existsSync('target-ready.txt') ? 'Device \\u2022 runtime-1 \\u2022 generic' : 'offline')\"",
        readyPattern: "runtime-1",
        notReadyPattern: "offline",
        readyTargetPattern: "^.*?\\u2022\\s*(?<id>runtime-1)\\s*\\u2022\\s*generic",
        runtimeReadyPattern: "app-ready-runtime-1",
        targetStopCommand: "node -e \"require('fs').writeFileSync('target-stopped.txt','stopped')\"",
        runCommand: "node -e \"console.log('app-ready-{runTargetId}'); setInterval(() => {}, 1000)\"",
        diagnosticCommands: [],
        recoveryCommands: [],
        retryAfterRecovery: true,
        timeoutSeconds: 5
      }]
    });

    const services = await startRuntimeService({ projectRoot: root, profileId: "device-target" });
    const service = services.find((item) => item.profileId === "device-target")!;
    const ready = await waitForRuntimeServiceReady(root, service.id, { timeoutMs: 5000 });

    expect(ready).toMatchObject({
      status: "running",
      targetId: "device-1",
      runTargetId: "runtime-1",
      targetStartedByService: true
    });
    expect(ready.command).toContain("app-ready-runtime-1");
    await stopRuntimeService(root, ready.id);
    await expect(readFile(path.join(root, "target-stopped.txt"), "utf8")).resolves.toBe("stopped");
  });

  it("captures an emitted runtime URL onto the service", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-runtime-url-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      runTargetProfiles: [
        {
          id: "web",
          label: "Web",
          kind: "web",
          cwd: "",
          runCommand: "node -e \"console.log('  ➜  Network: http://192.168.0.20:5179/'); console.log('  ➜  Local:   http://localhost:5179/'); setInterval(() => {}, 1000)\"",
          targetRequired: false,
          diagnosticCommands: [],
          recoveryCommands: [],
          retryAfterRecovery: true,
          timeoutSeconds: 90
        }
      ]
    });

    const services = await startRuntimeService({ projectRoot: root, profileId: "web" });
    const service = services.find((item) => item.profileId === "web")!;
    const url = await waitForRuntimeUrl(root, service.id);

    expect(["http://localhost:5179/", "http://192.168.0.20:5179/"]).toContain(url);

    await stopRuntimeService(root, service.id);
  });

  it("does not mistake a pre-existing listener for the runtime it just launched", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-runtime-port-conflict-"));
    const orphan = createServer((_request, response) => response.end("old unrelated app"));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      orphan.once("error", onError);
      orphan.listen(0, "127.0.0.1", () => {
        orphan.removeListener("error", onError);
        resolve();
      });
    });
    const address = orphan.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP port for the fixture server.");
    const occupiedPort = address.port;
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      runTargetProfiles: [{
        id: "web-conflict",
        label: "Web Conflict",
        kind: "web",
        url: `http://127.0.0.1:${occupiedPort}/`,
        ports: [occupiedPort],
        runCommand: "node -e \"const s=require('http').createServer((_q,r)=>r.end('new reviewed app')); s.listen(0,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:'+s.address().port+'/'))\"",
        targetRequired: false,
        diagnosticCommands: [],
        recoveryCommands: [],
        retryAfterRecovery: true,
        timeoutSeconds: 5
      }]
    });

    let serviceId = "";
    const within = async <T>(label: string, operation: Promise<T>): Promise<T> => Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`Timed out during ${label}`)), 2000))
    ]);
    try {
      const services = await within("runtime launch", startRuntimeService({ projectRoot: root, profileId: "web-conflict" }));
      serviceId = services.find((item) => item.profileId === "web-conflict")!.id;
      const ready = await within("runtime readiness", waitForRuntimeServiceReady(root, serviceId, { timeoutMs: 5000 }));

      expect(ready.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(ready.url).not.toBe(`http://127.0.0.1:${occupiedPort}/`);
      await expect(within("new runtime request", fetch(ready.url!).then((response) => response.text()))).resolves.toBe("new reviewed app");
      await expect(within("old listener request", fetch(`http://127.0.0.1:${occupiedPort}/`).then((response) => response.text()))).resolves.toBe("old unrelated app");
      expect(ready.logs.some((entry) => entry.text.includes("will not treat the existing listener as this runtime"))).toBe(true);
    } finally {
      if (serviceId) await within("runtime stop", stopRuntimeService(root, serviceId));
      orphan.closeAllConnections();
      await within("fixture listener close", new Promise<void>((resolve, reject) => orphan.close((error) => error ? reject(error) : resolve())));
    }
  });

  it("strips ANSI escapes before storing and linking runtime URLs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-runtime-ansi-url-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      runTargetProfiles: [
        {
          id: "web",
          label: "Web",
          kind: "web",
          cwd: "",
          runCommand: "node -e \"const e=String.fromCharCode(27); process.stdout.write(e+'[32mLocal: http://localhost:'+e+'[1m5180'+e+'[22m/'+e+'[39m\\n'); setInterval(() => {}, 1000)\"",
          targetRequired: false,
          diagnosticCommands: [],
          recoveryCommands: [],
          retryAfterRecovery: true,
          timeoutSeconds: 90
        }
      ]
    });

    const services = await startRuntimeService({ projectRoot: root, profileId: "web" });
    const service = services.find((item) => item.profileId === "web")!;
    const url = await waitForRuntimeUrl(root, service.id);
    const updated = (await listRuntimeServices(root)).find((item) => item.id === service.id)!;

    expect(url).toBe("http://localhost:5180/");
    expect(updated.logs.map((line) => line.text).join("\n")).not.toContain("\u001b");

    await stopRuntimeService(root, service.id);
  });

  it("does not treat a 404 app URL as runtime readiness", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-runtime-404-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      runTargetProfiles: [{
        id: "web-404",
        label: "Web 404",
        kind: "web",
        url: "http://127.0.0.1:4173/",
        runCommand: "node -e \"setInterval(() => {}, 1000)\"",
        targetRequired: false,
        diagnosticCommands: [],
        recoveryCommands: [],
        retryAfterRecovery: true,
        timeoutSeconds: 5
      }]
    });
    const services = await startRuntimeService({ projectRoot: root, profileId: "web-404" });
    const service = services.find((item) => item.profileId === "web-404")!;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not ready", { status: 404 })));
    try {
      await expect(waitForRuntimeServiceReady(root, service.id, { timeoutMs: 1200 })).rejects.toThrow(/did not become ready/);
    } finally {
      vi.unstubAllGlobals();
      await stopRuntimeService(root, service.id);
    }
  });

  it("requires an explicit readiness signal for generic desktop/native runtimes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-runtime-explicit-readiness-"));
    const bundle = await ensureProject(root);
    await updateProjectSettings(root, {
      ...bundle.project.settings,
      runTargetProfiles: [{
        id: "generic-slow",
        label: "Generic Slow",
        kind: "generic",
        runCommand: "node -e \"console.log('booting'); setInterval(() => {}, 1000)\"",
        targetRequired: false,
        diagnosticCommands: [],
        recoveryCommands: [],
        retryAfterRecovery: true,
        timeoutSeconds: 5
      }]
    });
    const services = await startRuntimeService({ projectRoot: root, profileId: "generic-slow" });
    const service = services.find((item) => item.profileId === "generic-slow")!;

    await expect(waitForRuntimeServiceReady(root, service.id, { timeoutMs: 1800 })).rejects.toThrow(/Configure runtimeReadyPattern, healthCommand, or an app URL/);
    await stopRuntimeService(root, service.id);
  });
});
