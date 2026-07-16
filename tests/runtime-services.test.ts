import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureProject, updateProjectSettings } from "../src/main/storage/projectStore";
import { listRuntimeServices, runtimeServiceSpawnOptions, startRuntimeService, stopRuntimeService } from "../src/main/storage/runtimeServices";
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
});
