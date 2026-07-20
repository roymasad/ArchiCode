import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inferCommandSettings } from "../src/main/storage/commandInference";
import { createProject, ensureEmptyCodebaseProject, ensureFixtureProject, loadProject, migrateDefaultPhaseModelPolicies, setGlobalMcpSettingsStore, setGlobalProviderSettingsStore, updateProjectSettings } from "../src/main/storage/projectStore";
import { createSeedProject } from "../src/shared/fixtures";
import { defaultPhaseModelPolicies, type ProjectSettings } from "../src/shared/schema";
import { createProjectFromTemplate, projectTemplates } from "../src/shared/templates";

describe("project templates", () => {
  it("declares first-run templates", () => {
    expect(projectTemplates.map((template) => template.id)).toEqual(["blank", "website", "flutter-calculator", "c4-todo-app"]);
    expect(projectTemplates.map((template) => template.name)).toEqual(["Blank", "Website", "Flutter Calculator App", "C4 Todo App"]);
  });

  it("creates readable project and flow JSON from each template", () => {
    for (const template of projectTemplates) {
      const result = createProjectFromTemplate(`/tmp/${template.id}`, template.id);
      expect(result.project.settings.providers).toHaveLength(1);
      expect(result.project.settings.providers[0]).toMatchObject({ label: "LLM Provider", enabled: true });
      expect(result.project.settings.filesystem.policy).toBe("project-write");
      expect(result.project.settings.autoFocusSelectedNode).toBe(false);
      expect(result.project.settings.webSearch.enabled).toBe(true);
      expect(result.flow.nodes.length).toBeGreaterThan(0);
      expect(result.flow.edges.length).toBeGreaterThanOrEqual(0);
    }
  });

  it("uses the website template for a simple Vue/Vite two-page website", () => {
    const result = createProjectFromTemplate("/tmp/website", "website");
    const nodeTitles = result.flow.nodes.map((node) => node.title);
    const fullText = result.flow.nodes.map((node) => [
      node.title,
      node.description,
      node.techStack.join(" "),
      node.acceptanceCriteria.join(" ")
    ].join(" ")).join(" ");

    expect(nodeTitles).toEqual(["Product Goal", "Vue/Vite Architecture", "Landing Page", "About Page"]);
    expect(nodeTitles).not.toContain("Build And Run");
    expect(fullText).toContain("Vue 3");
    expect(fullText).toContain("Vite");
    expect(fullText).toContain("/about");
    expect(fullText).toContain("landing page at /");
    expect(result.project.settings.stackAssumptions).toEqual(["Vue 3", "Vite", "Vue Router", "TypeScript", "Static website"]);
    expect(result.project.settings.stackAssumptions).not.toContain("Electron");
    expect(result.project.settings.stackAssumptions).not.toContain("React");
    expect(result.project.settings.runTargetProfiles.map((profile) => profile.label)).toContain("Local Browser");
  });

  it("uses the blank template for a minimal editable starting point", () => {
    const result = createProjectFromTemplate("/tmp/blank", "blank");

    expect(result.project.name).toBe("New Blank Project");
    expect(result.flow.name).toBe("Blank Plan");
    expect(result.flow.nodes).toHaveLength(1);
    expect(result.flow.nodes[0]?.title).toBe("Project Goal");
    expect(result.flow.edges).toHaveLength(0);
    expect(result.project.settings.defaultBuildCommand).toBe("");
    expect(result.project.settings.defaultRunCommand).toBe("");
    expect(result.project.settings.runTargetProfiles).toEqual([]);
    expect(result.project.settings.stackAssumptions).toEqual([]);
  });

  it("uses the Flutter calculator template for a small calculator app", () => {
    const result = createProjectFromTemplate("/tmp/flutter-calculator", "flutter-calculator");
    const nodeTitles = result.flow.nodes.map((node) => node.title);
    const fullText = result.flow.nodes.map((node) => [
      node.title,
      node.description,
      node.techStack.join(" "),
      node.acceptanceCriteria.join(" ")
    ].join(" ")).join(" ");

    expect(result.project.name).toBe("New Flutter Calculator");
    expect(result.project.settings.defaultBuildCommand).toBe("flutter build apk");
    expect(result.project.settings.defaultRunCommand).toBe("flutter run");
    expect(result.project.settings.stackAssumptions).toEqual(["Flutter", "Dart", "Material", "Widget tests"]);
    expect(result.project.settings.stackAssumptions).not.toContain("React");
    expect(result.project.settings.stackAssumptions).not.toContain("Electron");
    expect(result.flow.name).toBe("Flutter Calculator Plan");
    expect(nodeTitles).toEqual(["Calculator Goal", "Flutter Architecture", "Calculator UI", "Calculation Logic", "Verification"]);
    expect(fullText).toContain("Flutter");
    expect(fullText).toContain("Dart");
    expect(fullText).toContain("divide-by-zero");
  });

  it("uses the C4 todo template for a nested React and SQLite architecture", () => {
    const result = createProjectFromTemplate("/tmp/c4-todo", "c4-todo-app");
    const nodeTitles = result.flow.nodes.map((node) => node.title);
    const fullText = result.flow.nodes.map((node) => [
      node.title,
      node.description,
      node.techStack.join(" "),
      node.acceptanceCriteria.join(" ")
    ].join(" ")).join(" ");

    expect(result.project.name).toBe("New C4 Todo App");
    expect(result.project.settings.defaultBuildCommand).toBe("npm run build");
    expect(result.project.settings.defaultRunCommand).toBe("npm run dev");
    expect(result.flow.name).toBe("C4 Todo App Plan");
    expect(nodeTitles).toContain("Todo App System");
    expect(nodeTitles).toContain("React Web App");
    expect(nodeTitles).toContain("Express API");
    expect(nodeTitles).toContain("SQLite Database");
    expect(fullText).toContain("React");
    expect(fullText).toContain("SQLite");
    expect(fullText).toContain("Prisma");
    expect(result.flow.subflows.find((subflow) => subflow.id === "subflow-containers")?.parentNodeId).toBe("node-system-todo");
    expect(result.flow.subflows.find((subflow) => subflow.id === "subflow-web-components")?.parentSubflowId).toBe("subflow-containers");
    expect(result.flow.subflows.find((subflow) => subflow.id === "subflow-api-components")?.parentSubflowId).toBe("subflow-containers");
    expect(result.flow.nodes.find((node) => node.id === "node-component-routes")?.subflowId).toBe("subflow-api-components");
  });

  it("persists a new project from a selected template", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-template-"));
    const bundle = await createProject(root, "flutter-calculator");
    const reloaded = await loadProject(root);

    expect(bundle.project.name).toBe("New Flutter Calculator");
    expect(bundle.project.settings.defaultBuildCommand).toBe("flutter build apk");
    expect(bundle.project.settings.defaultRunCommand).toBe("flutter run");
    expect(reloaded.flows[0]?.name).toBe("Flutter Calculator Plan");
    expect(reloaded.notes[0]?.body).toContain("flutter-calculator");

    const diskFlow = JSON.parse(await readFile(path.join(root, ".archicode", "flows", "flow-main.json"), "utf8")) as {
      nodes: Record<string, { id: string; updatedAt?: string }>;
      edges: Record<string, { id: string }>;
      updatedAt?: string;
    };
    expect(Array.isArray(diskFlow.nodes)).toBe(false);
    // Disk keys must preserve entity insertion order — layout and flag
    // reconciliation depend on node array order surviving a save/load cycle.
    expect(Object.keys(diskFlow.nodes)).toEqual(reloaded.flows[0]!.nodes.map((node) => node.id));
    expect(Object.values(diskFlow.nodes).every((node) => node.updatedAt === undefined)).toBe(true);
    expect(diskFlow.updatedAt).toBeUndefined();
    const gitattributes = await readFile(path.join(root, ".gitattributes"), "utf8");
    expect(gitattributes).toContain(".archicode/graph-changes.jsonl merge=union");
    expect(gitattributes).toContain(".archicode/graph-changes-archive.jsonl merge=union");
    expect(gitattributes).toContain(".archicode/notes.jsonl merge=union");
  });

  it("initializes existing codebases with an empty map instead of the sample graph", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-existing-codebase-"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }), "utf8");
    await writeFile(path.join(root, ".gitignore"), "node_modules/\n", "utf8");

    const bundle = await ensureEmptyCodebaseProject(root);
    const reloaded = await loadProject(root);
    const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");

    expect(bundle.project.name).toBe(path.basename(root));
    expect(bundle.project.settings.defaultBuildCommand).toBe("npm run build");
    expect(bundle.flows[0]?.name).toBe("Codebase Map");
    expect(bundle.flows[0]?.nodes).toEqual([]);
    expect(bundle.flows[0]?.edges).toEqual([]);
    expect(reloaded.notes).toEqual([]);
    expect(reloaded.flows[0]?.nodes).toEqual([]);
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain(".archicode/local.json");
    expect(gitignore).toContain(".archicode/runs/");
    expect(gitignore).toContain(".archicode/incidents/");
    expect(gitignore).toContain(".archicode/artifacts/");
  });

  it("keeps shared project JSON portable while preserving local settings in an ignored overlay", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-local-overlay-"));
    const bundle = await createProject(root, "website");
    const shellPolicy = {
      id: "policy-build",
      command: "npm run build",
      cwd: root,
      env: [],
      risk: "medium" as const,
      filesystemPolicy: "project-write" as const,
      allowedRoots: [root],
      reusable: true,
      createdAt: new Date().toISOString()
    };

    await updateProjectSettings(root, {
      ...bundle.project.settings,
      filesystem: {
        policy: "project-write",
        allowedRoots: [path.join(root, "generated")],
        blockOutsideProjectPaths: true
      },
      allowedShellCommands: ["npm run build"],
      shellPolicies: [shellPolicy],
      providers: bundle.project.settings.providers.map((provider) =>
        provider.id === "openai-compatible"
          ? {
              ...provider,
              detectedContextWindowTokens: 123456,
              detectedAvailableModels: ["local-model"],
              enabled: true
            }
          : { ...provider, enabled: false }
      ),
      notifications: { jobFinished: false, reviewRequired: false },
      canvasBackground: "deep-slate" as const,
      canvasEdgeStyle: "curved" as const
    });

    const sharedProject = JSON.parse(await readFile(path.join(root, ".archicode", "project.json"), "utf8")) as {
      rootPath: string;
      settings: {
        localEnvironment?: { operatingSystem?: string; agentShell?: string; projectRoot?: string };
        filesystem: { allowedRoots: string[] };
        allowedShellCommands: string[];
        shellPolicies: unknown[];
        providers: unknown[];
        mcp: { servers: unknown[] };
        notifications: { jobFinished: boolean; reviewRequired: boolean };
        canvasBackground: string;
        canvasEdgeStyle: string;
      };
    };
    const localState = JSON.parse(await readFile(path.join(root, ".archicode", "local.json"), "utf8")) as {
      rootPath: string;
      settings: {
        localEnvironment?: { operatingSystem?: string; agentShell?: string; projectRoot?: string };
        filesystem: { allowedRoots: string[] };
        allowedShellCommands: string[];
        shellPolicies: unknown[];
        providers: Array<{ id: string; detectedAvailableModels?: string[]; detectedContextWindowTokens?: number; enabled?: boolean }>;
        notifications?: { jobFinished: boolean; reviewRequired: boolean };
        canvasBackground?: string;
        canvasEdgeStyle?: string;
      };
    };
    const reloaded = await loadProject(root);

    expect(sharedProject.rootPath).toBe(".");
    expect(sharedProject.settings.filesystem.allowedRoots).toEqual([]);
    expect(sharedProject.settings.localEnvironment).toBeUndefined();
    expect(sharedProject.settings.allowedShellCommands).toEqual([]);
    expect(sharedProject.settings.shellPolicies).toEqual([]);
    // Providers are a workstation preference, not a project fact: never written to the shared file.
    expect(sharedProject.settings.providers).toEqual([]);
    // MCP servers are an app-wide preference (see the dedicated global-store test below):
    // never written to the shared file either.
    expect(sharedProject.settings.mcp.servers).toEqual([]);
    // Personal app preferences reset to schema defaults in the shared file.
    expect(sharedProject.settings.notifications).toEqual({ jobFinished: true, reviewRequired: true });
    expect(sharedProject.settings.canvasBackground).toBe("neutral-gray");
    expect(sharedProject.settings.canvasEdgeStyle).toBe("current");
    expect(localState.rootPath).toBe(root);
    expect(localState.settings.localEnvironment?.projectRoot).toBe(root);
    expect(localState.settings.localEnvironment?.agentShell).toBe(process.platform === "win32" ? "powershell.exe" : process.platform === "darwin" ? "/bin/zsh" : process.env.SHELL || "/bin/bash");
    expect(localState.settings.filesystem.allowedRoots).toEqual([path.join(root, "generated")]);
    expect(localState.settings.allowedShellCommands).toEqual(["npm run build"]);
    expect(localState.settings.shellPolicies).toHaveLength(1);
    expect(localState.settings.providers.find((provider) => provider.id === "openai-compatible")?.detectedAvailableModels).toEqual(["local-model"]);
    expect(localState.settings.notifications).toEqual({ jobFinished: false, reviewRequired: false });
    expect(localState.settings.canvasBackground).toBe("deep-slate");
    expect(localState.settings.canvasEdgeStyle).toBe("curved");
    expect(reloaded.project.rootPath).toBe(root);
    expect(reloaded.project.settings.localEnvironment?.projectRoot).toBe(root);
    expect(reloaded.project.settings.shellPolicies).toHaveLength(1);
    expect(reloaded.project.settings.providers.find((provider) => provider.id === "openai-compatible")?.detectedContextWindowTokens).toBe(123456);
    expect(reloaded.project.settings.notifications).toEqual({ jobFinished: false, reviewRequired: false });
    expect(reloaded.project.settings.canvasBackground).toBe("deep-slate");
    expect(reloaded.project.settings.canvasEdgeStyle).toBe("curved");
  });

  it("migrates an old-format project.json (providers still embedded) without losing data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-migration-"));
    const bundle = await createProject(root, "website");
    const archicodeDir = path.join(root, ".archicode");

    // Simulate what an older app version wrote: providers, notifications,
    // and canvas cosmetics fully embedded in the shared file (secrets already stripped,
    // but the rest of the config was not yet moved to local-only storage).
    const legacyProviders = bundle.project.settings.providers.map((provider) =>
      provider.id === "openai-compatible" ? { ...provider, model: "legacy-model", enabled: true } : { ...provider, enabled: false }
    );
    const legacySharedProject = {
      ...bundle.project,
      settings: {
        ...bundle.project.settings,
        providers: legacyProviders,
        notifications: { jobFinished: false, reviewRequired: false },
        canvasBackground: "deep-slate",
        canvasEdgeStyle: "curved"
      }
    };
    await writeFile(path.join(archicodeDir, "project.json"), JSON.stringify(legacySharedProject, null, 2), "utf8");

    // Simulate an older local.json: only the narrow runtime-only provider fields,
    // none of the newly-local settings (mcpServerSecrets, ...).
    const legacyLocalState = {
      schemaVersion: 1,
      rootPath: root,
      settings: {
        filesystem: bundle.project.settings.filesystem,
        allowedShellCommands: [],
        shellPolicies: [],
        providers: legacyProviders.map((provider) => ({ id: provider.id, enabled: provider.enabled }))
      },
      updatedAt: new Date().toISOString()
    };
    await writeFile(path.join(archicodeDir, "local.json"), JSON.stringify(legacyLocalState, null, 2), "utf8");

    const reloaded = await loadProject(root);

    // No data lost: the legacy values (only ever found in the old shared file) survive the migration.
    expect(reloaded.project.settings.providers.find((provider) => provider.id === "openai-compatible")).toMatchObject({ model: "legacy-model", enabled: true });
    expect(reloaded.project.settings.notifications).toEqual({ jobFinished: false, reviewRequired: false });
    expect(reloaded.project.settings.canvasBackground).toBe("deep-slate");
    expect(reloaded.project.settings.canvasEdgeStyle).toBe("curved");

    // Migration completes in place: the shared file is rewritten to the new (empty/default) shape...
    const sharedProject = JSON.parse(await readFile(path.join(archicodeDir, "project.json"), "utf8")) as {
      settings: { providers: unknown[]; canvasBackground: string };
    };
    expect(sharedProject.settings.providers).toEqual([]);
    expect(sharedProject.settings.canvasBackground).toBe("neutral-gray");

    // ...and local.json now carries the full, previously-shared data forward.
    const localState = JSON.parse(await readFile(path.join(archicodeDir, "local.json"), "utf8")) as {
      settings: {
        providers: Array<{ id: string; model?: string; enabled?: boolean }>;
        canvasBackground?: string;
      };
    };
    expect(localState.settings.providers.find((provider) => provider.id === "openai-compatible")).toMatchObject({ model: "legacy-model", enabled: true });
    expect(localState.settings.canvasBackground).toBe("deep-slate");

    // A second load is now fully driven by local.json and remains stable (no further rewrite needed).
    const reloadedAgain = await loadProject(root);
    expect(reloadedAgain.project.settings.providers.find((provider) => provider.id === "openai-compatible")).toMatchObject({ model: "legacy-model", enabled: true });
  });

  it("reuses global LLM provider settings across projects", async () => {
    let globalProviders = createSeedProject("/tmp/global-providers").project.settings.providers.map((provider) =>
      provider.id === "openai-compatible" ? { ...provider, model: "global-model", enabled: true } : { ...provider, enabled: false }
    );
    setGlobalProviderSettingsStore({
      load: async () => globalProviders,
      save: async (providers) => {
        globalProviders = providers;
      }
    });

    try {
      const firstRoot = await mkdtemp(path.join(tmpdir(), "archicode-global-provider-one-"));
      const first = await ensureFixtureProject(firstRoot);
      expect(first.project.settings.providers.find((provider) => provider.id === "openai-compatible")?.model).toBe("global-model");

      await updateProjectSettings(firstRoot, {
        ...first.project.settings,
        providers: first.project.settings.providers.map((provider) =>
          provider.id === "openai-compatible" ? { ...provider, model: "saved-global-model" } : provider
        )
      });

      const secondRoot = await mkdtemp(path.join(tmpdir(), "archicode-global-provider-two-"));
      const second = await ensureFixtureProject(secondRoot);
      expect(second.project.settings.providers.find((provider) => provider.id === "openai-compatible")?.model).toBe("saved-global-model");
    } finally {
      setGlobalProviderSettingsStore(null);
    }
  });

  it("reuses global MCP server settings across projects", async () => {
    let globalMcp: ProjectSettings["mcp"] | null = null;
    setGlobalMcpSettingsStore({
      load: async () => globalMcp,
      save: async (settings) => {
        globalMcp = settings;
      }
    });

    try {
      const firstRoot = await mkdtemp(path.join(tmpdir(), "archicode-global-mcp-one-"));
      const first = await ensureFixtureProject(firstRoot);
      expect(first.project.settings.mcp.servers).toEqual([]);

      await updateProjectSettings(firstRoot, {
        ...first.project.settings,
        mcp: {
          ...first.project.settings.mcp,
          servers: [
            {
              id: "mcp-secret-server",
              label: "Secret Server",
              transport: "streamable-http" as const,
              url: "https://example.com/mcp",
              args: [],
              env: [{ name: "API_TOKEN", value: "super-secret-token" }],
              headers: [{ name: "Authorization", value: "Bearer super-secret-token" }],
              enabled: true,
              trusted: true,
              source: "project" as const,
              tools: [],
              resources: [],
              prompts: []
            }
          ]
        }
      });

      // A second, unrelated project immediately sees the same server, secrets included.
      const secondRoot = await mkdtemp(path.join(tmpdir(), "archicode-global-mcp-two-"));
      const second = await ensureFixtureProject(secondRoot);
      expect(second.project.settings.mcp.servers[0]?.env[0]).toEqual({ name: "API_TOKEN", value: "super-secret-token" });
      expect(second.project.settings.mcp.servers[0]?.headers[0]).toEqual({ name: "Authorization", value: "Bearer super-secret-token" });

      // Never written to either project's shared file.
      const sharedFirst = JSON.parse(await readFile(path.join(firstRoot, ".archicode", "project.json"), "utf8")) as {
        settings: { mcp: { servers: unknown[] } };
      };
      const sharedSecond = JSON.parse(await readFile(path.join(secondRoot, ".archicode", "project.json"), "utf8")) as {
        settings: { mcp: { servers: unknown[] } };
      };
      expect(sharedFirst.settings.mcp.servers).toEqual([]);
      expect(sharedSecond.settings.mcp.servers).toEqual([]);
    } finally {
      setGlobalMcpSettingsStore(null);
    }
  });

  it("loads global provider metadata without requesting keychain secrets", async () => {
    const globalProviders = createSeedProject("/tmp/global-provider-metadata").project.settings.providers.map((provider) =>
      provider.id === "openai-compatible" ? { ...provider, model: "metadata-model", enabled: true } : { ...provider, enabled: false }
    );
    const loadOptions: Array<{ includeSecrets?: boolean } | undefined> = [];
    const saveOptions: Array<{ preserveMissingSecrets?: boolean } | undefined> = [];
    let secretLoads = 0;
    setGlobalProviderSettingsStore({
      load: async (options) => {
        loadOptions.push(options);
        return globalProviders.map((provider) =>
          options?.includeSecrets && provider.id === "openai-compatible" ? { ...provider, apiKey: "sk-global-secret" } : provider
        );
      },
      loadSecret: async () => {
        secretLoads += 1;
        return "sk-global-secret";
      },
      save: async (_providers, options) => {
        saveOptions.push(options);
      }
    });

    try {
      const root = await mkdtemp(path.join(tmpdir(), "archicode-global-provider-metadata-"));
      const bundle = await ensureFixtureProject(root);
      const provider = bundle.project.settings.providers.find((item) => item.id === "openai-compatible");
      expect(provider?.model).toBe("metadata-model");
      expect(provider?.apiKey).toBeUndefined();
      expect(loadOptions.every((options) => options?.includeSecrets === false)).toBe(true);
      expect(secretLoads).toBe(0);

      await updateProjectSettings(root, bundle.project.settings);
      expect(saveOptions.at(-1)?.preserveMissingSecrets).toBe(true);
      expect(secretLoads).toBe(0);
    } finally {
      setGlobalProviderSettingsStore(null);
    }
  });

  it("migrates untouched legacy provider phase output budgets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-policy-migration-"));
    const bundle = await createProject(root, "website");
    const legacyPolicies = {
      planning: { temperature: 0.2, reasoningMode: "high" as const, maxOutputTokens: 2400, enabledTools: [] },
      coding: { temperature: 0.1, reasoningMode: "medium" as const, maxOutputTokens: 3200, enabledTools: [] },
      debugging: { temperature: 0.0, reasoningMode: "high" as const, maxOutputTokens: 3200, enabledTools: [] },
      review: { temperature: 0.1, reasoningMode: "medium" as const, maxOutputTokens: 2200, enabledTools: [] },
      verifying: { temperature: 0.0, reasoningMode: "low" as const, maxOutputTokens: 1200, enabledTools: [] },
      summarizing: { temperature: 0.1, reasoningMode: "low" as const, maxOutputTokens: 1600, enabledTools: [] },
      brainstorming: { temperature: 0.6, reasoningMode: "medium" as const, maxOutputTokens: 2600, enabledTools: [] }
    };

    await updateProjectSettings(root, {
      ...bundle.project.settings,
      providers: bundle.project.settings.providers.map((provider) =>
        provider.id === "openai-compatible"
          ? { ...provider, phaseModelPolicies: legacyPolicies }
          : provider
      )
    });

    const reloaded = await loadProject(root);
    const provider = reloaded.project.settings.providers.find((item) => item.id === "openai-compatible");

    expect(provider?.phaseModelPolicies.coding.maxOutputTokens).toBe(defaultPhaseModelPolicies.coding.maxOutputTokens);
    expect(provider?.phaseModelPolicies.planning.maxOutputTokens).toBe(defaultPhaseModelPolicies.planning.maxOutputTokens);
    expect(provider?.phaseModelPolicies.summarizing.maxOutputTokens).toBe(8000);
    expect(provider?.phaseModelPolicies.brainstorming.maxOutputTokens).toBe(24000);
  });

  it("migrates the previous Chat Research default without replacing a custom output budget", () => {
    const provider = createSeedProject("/tmp/archicode").project.settings.providers[0]!;
    const previousPolicies = {
      ...provider.phaseModelPolicies,
      summarizing: {
        ...provider.phaseModelPolicies.summarizing,
        maxOutputTokens: 4000
      },
      brainstorming: {
        ...provider.phaseModelPolicies.brainstorming,
        maxOutputTokens: 12000
      }
    };

    const migrated = migrateDefaultPhaseModelPolicies({
      ...provider,
      phaseModelPolicies: previousPolicies
    });
    const customized = migrateDefaultPhaseModelPolicies({
      ...provider,
      phaseModelPolicies: {
        ...previousPolicies,
        brainstorming: {
          ...previousPolicies.brainstorming,
          maxOutputTokens: 18000
        }
      }
    });
    const customSummary = migrateDefaultPhaseModelPolicies({
      ...provider,
      phaseModelPolicies: {
        ...previousPolicies,
        summarizing: {
          ...previousPolicies.summarizing,
          maxOutputTokens: 6000
        }
      }
    });

    expect(migrated.phaseModelPolicies.summarizing.maxOutputTokens).toBe(8000);
    expect(migrated.phaseModelPolicies.brainstorming.maxOutputTokens).toBe(24000);
    expect(customized.phaseModelPolicies.brainstorming.maxOutputTokens).toBe(18000);
    expect(customSummary.phaseModelPolicies.summarizing.maxOutputTokens).toBe(6000);
  });

  it("infers npm commands from package scripts without preapproving them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-package-"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        build: "vite build",
        dev: "vite --host",
        test: "vitest"
      }
    }), "utf8");

    const bundle = await createProject(root, "website");

    expect(bundle.project.settings.defaultBuildCommand).toBe("npm run build");
    expect(bundle.project.settings.defaultRunCommand).toBe("npm run dev");
    expect(bundle.project.settings.runTargetProfiles[0]?.label).toBe("Local Browser");
    expect(bundle.project.settings.runTargetProfiles[0]?.runCommand).toBe("npm run dev");
    expect(bundle.project.settings.allowedShellCommands).toEqual([]);
  });

  it("does not infer runtime or watch scripts as build verification commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-runtime-build-script-"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        build: "vite preview --host 0.0.0.0",
        dev: "vite --host 0.0.0.0"
      }
    }), "utf8");

    const inferred = await inferCommandSettings(root);

    expect(inferred.defaultBuildCommand).toBe("");
    expect(inferred.defaultRunCommand).toBe("npm run dev");
  });

  it("uses package manager lockfiles when inferring package commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-pnpm-"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        build: "vite build",
        start: "vite preview"
      }
    }), "utf8");
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    const inferred = await inferCommandSettings(root);

    expect(inferred.defaultBuildCommand).toBe("pnpm run build");
    expect(inferred.defaultRunCommand).toBe("pnpm run start");
    expect(inferred.runTargetProfiles[0]?.runCommand).toBe("pnpm run start");
    expect(inferred.allowedShellCommands).toEqual([]);
  });

  it("infers runnable monorepo workspace profiles with module cwd", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-monorepo-"));
    await mkdir(path.join(root, "apps", "web"), { recursive: true });
    await mkdir(path.join(root, "apps", "api"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      workspaces: ["apps/*"],
      scripts: {
        build: "turbo build"
      }
    }), "utf8");
    await writeFile(path.join(root, "apps", "web", "package.json"), JSON.stringify({
      name: "@demo/web",
      scripts: {
        dev: "vite --host",
        build: "vite build",
        test: "vitest"
      },
      dependencies: {
        react: "latest",
        vite: "latest"
      }
    }), "utf8");
    await writeFile(path.join(root, "apps", "api", "package.json"), JSON.stringify({
      name: "@demo/api",
      scripts: {
        dev: "tsx src/server.ts",
        test: "vitest"
      },
      dependencies: {
        express: "latest"
      }
    }), "utf8");

    const inferred = await inferCommandSettings(root);

    expect(inferred.defaultBuildCommand).toBe("npm run build");
    expect(inferred.defaultRunCommand).toBe("");
    expect(inferred.runTargetProfiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "apps-web",
        label: "Web",
        kind: "web",
        cwd: "apps/web",
        runCommand: "npm run dev",
        buildCommand: "npm run build",
        testCommand: "npm run test",
        inferred: true
      }),
      expect.objectContaining({
        id: "apps-api",
        label: "Api",
        kind: "api",
        cwd: "apps/api",
        runCommand: "npm run dev",
        testCommand: "npm run test",
        inferred: true
      })
    ]));
  });

  it("infers runnable shallow package folders outside common workspace names", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-shallow-package-"));
    await mkdir(path.join(root, "frontend"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        build: "npm run build --prefix frontend"
      }
    }), "utf8");
    await writeFile(path.join(root, "frontend", "package.json"), JSON.stringify({
      name: "demo-frontend",
      scripts: {
        dev: "vite --host",
        build: "vite build"
      },
      dependencies: {
        react: "latest",
        vite: "latest"
      }
    }), "utf8");

    const inferred = await inferCommandSettings(root);

    expect(inferred.runTargetProfiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "frontend",
        label: "Demo Frontend",
        kind: "web",
        cwd: "frontend",
        runCommand: "npm run dev",
        buildCommand: "npm run build",
        inferred: true
      })
    ]));
  });

  it("infers root package script-level runtime profiles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-script-runtimes-"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        dev: "concurrently \"npm:dev:api\" \"npm:dev:web\"",
        "dev:api": "tsx watch src/server/index.ts",
        "dev:web": "vite --host 127.0.0.1",
        "prisma:migrate": "prisma migrate dev --name init",
        build: "tsc -p tsconfig.server.json && vite build",
        test: "vitest run"
      },
      dependencies: {
        express: "latest",
        react: "latest"
      },
      devDependencies: {
        vite: "latest",
        tsx: "latest"
      }
    }), "utf8");

    const inferred = await inferCommandSettings(root);

    expect(inferred.runTargetProfiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "script-dev-api",
        label: "Api",
        kind: "api",
        cwd: "",
        runCommand: "npm run dev:api",
        setupCommand: "npm run prisma:migrate",
        inferred: true
      }),
      expect.objectContaining({
        id: "script-dev-web",
        label: "Web",
        kind: "web",
        cwd: "",
        runCommand: "npm run dev:web",
        setupCommand: "npm run prisma:migrate",
        inferred: true
      })
    ]));
  });

  it("enriches existing inferred profiles with newly inferred setup commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-profile-setup-enrich-"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        "dev:api": "tsx src/server.ts",
        "prisma:migrate": "prisma migrate dev --name init",
        build: "vite build"
      },
      dependencies: {
        express: "latest"
      }
    }), "utf8");

    const initial = await ensureFixtureProject(root);
    await updateProjectSettings(root, {
      ...initial.project.settings,
      runTargetProfiles: [
        {
          id: "script-dev-api",
          label: "Api",
          kind: "api",
          cwd: "",
          runCommand: "npm run dev:api",
          inferred: true,
          targetRequired: false,
          diagnosticCommands: [],
          recoveryCommands: [],
          retryAfterRecovery: true,
          timeoutSeconds: 120
        }
      ]
    });

    const reloaded = await loadProject(root);

    expect(reloaded.project.settings.runTargetProfiles.find((profile) => profile.id === "script-dev-api")).toEqual(expect.objectContaining({
      setupCommand: "npm run prisma:migrate"
    }));
  });

  it("adds newly inferred workspace profiles without replacing existing profiles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-profile-merge-"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        dev: "vite --host"
      }
    }), "utf8");

    const initial = await ensureFixtureProject(root);
    const initialProfileIds = initial.project.settings.runTargetProfiles.map((profile) => profile.id);

    await mkdir(path.join(root, "apps", "api"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      workspaces: ["apps/*"],
      scripts: {
        dev: "vite --host"
      }
    }), "utf8");
    await writeFile(path.join(root, "apps", "api", "package.json"), JSON.stringify({
      name: "@demo/api",
      scripts: {
        dev: "tsx src/server.ts"
      },
      dependencies: {
        express: "latest"
      }
    }), "utf8");

    const reloaded = await loadProject(root);

    expect(reloaded.project.settings.runTargetProfiles.map((profile) => profile.id)).toEqual(
      expect.arrayContaining([...initialProfileIds, "apps-api"])
    );
    expect(reloaded.project.settings.runTargetProfiles.find((profile) => profile.id === "apps-api")).toEqual(expect.objectContaining({
      cwd: "apps/api",
      runCommand: "npm run dev",
      kind: "api",
      inferred: true
    }));
  });

  it("infers Flutter run commands without npm defaults", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-flutter-"));
    await writeFile(path.join(root, "pubspec.yaml"), "name: sample_app\n", "utf8");
    await mkdir(path.join(root, "web"));

    const inferred = await inferCommandSettings(root);

    expect(inferred.defaultBuildCommand).toBe("flutter build web");
    expect(inferred.defaultRunCommand).toBe("flutter run");
    expect(inferred.runTargetProfiles.map((profile) => profile.label)).toEqual(["Android Emulator", "iOS Simulator"]);
    expect(inferred.allowedShellCommands).toEqual([]);
  });
});
