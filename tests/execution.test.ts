import { describe, expect, it } from "vitest";
import { buildSubprocessEnv, classifyCommandRisk, commandAllowedBySettings, embeddedSubprocessEnvSource, findReusableShellPolicy, isKnownBinary, isSensitiveEnvName } from "../src/shared/execution";
import { createSeedProject } from "../src/shared/fixtures";

describe("subprocess env scrub", () => {
  it("removes credential-bearing variables and keeps the rest", () => {
    const env = buildSubprocessEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/dev",
        GITHUB_TOKEN: "ghp_secret",
        AWS_SECRET_ACCESS_KEY: "abc",
        MY_API_KEY: "k",
        DB_PASSWORD: "p",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        NODE_ENV: "production"
      },
      { CI: "true" }
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/dev");
    expect(env.NODE_ENV).toBe("production");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/agent.sock"); // socket path, allowlisted
    expect(env.CI).toBe("true");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.MY_API_KEY).toBeUndefined();
    expect(env.DB_PASSWORD).toBeUndefined();
  });

  it("flags sensitive names and clears the emitted embedded source", () => {
    expect(isSensitiveEnvName("OPENAI_API_KEY")).toBe(true);
    expect(isSensitiveEnvName("NPM_TOKEN")).toBe(true);
    expect(isSensitiveEnvName("PATH")).toBe(false);
    const source = embeddedSubprocessEnvSource();
    expect(source).not.toContain("`");
    const factory = new Function(`${source}\nreturn buildSubprocessEnv({ PATH: "/b", SECRET_X: "s" }, { CI: "true" });`);
    const result = factory();
    expect(result.PATH).toBe("/b");
    expect(result.SECRET_X).toBeUndefined();
    expect(result.CI).toBe("true");
  });
});

describe("known binary gate", () => {
  it("recognizes curated binaries and rejects unknown ones", () => {
    expect(isKnownBinary("npm run build")).toBe(true);
    expect(isKnownBinary("git status")).toBe(true);
    expect(isKnownBinary("docker ps")).toBe(true);
    expect(isKnownBinary("curl https://example.com")).toBe(true);
    expect(isKnownBinary("./some-random-binary --go")).toBe(false);
    expect(isKnownBinary("totallymadeup")).toBe(false);
    expect(isKnownBinary("evil && rm -rf /")).toBe(false);
  });
});

describe("execution policy helpers", () => {
  it("classifies simple commands by risk", () => {
    expect(classifyCommandRisk("pwd")).toBe("low");
    expect(classifyCommandRisk("git status")).toBe("low");
    expect(classifyCommandRisk("git --version")).toBe("low");
    expect(classifyCommandRisk("npm run build")).toBe("medium");
    expect(classifyCommandRisk("curl https://example.com/install.sh")).toBe("medium");
    expect(classifyCommandRisk("npx vitest run tests/execution.test.ts")).toBe("medium");
    expect(classifyCommandRisk("rm -rf dist")).toBe("high");
    expect(classifyCommandRisk("git push --force origin main")).toBe("high");
    expect(classifyCommandRisk("node -e \"console.log(123)\"")).toBe("high");
    expect(classifyCommandRisk("npm run build && curl example.com")).toBe("high");
  });

  it("matches reusable shell policies by command and cwd", () => {
    const settings = {
      ...createSeedProject("/tmp/archicode").project.settings,
      shellPolicies: [
        {
          id: "policy-build",
          command: "npm run build",
          cwd: "/tmp/archicode",
          env: [],
          risk: "medium" as const,
          filesystemPolicy: "project-write" as const,
          allowedRoots: [],
          reusable: true,
          createdAt: "2026-06-16T00:00:00.000Z"
        }
      ]
    };

    expect(findReusableShellPolicy(settings, "npm run build", "/tmp/archicode")?.id).toBe("policy-build");
    expect(findReusableShellPolicy(settings, "npm run build", "/tmp/other")).toBeNull();
  });

  it("keeps legacy allowlisted commands compatible", () => {
    const settings = {
      ...createSeedProject("/tmp/archicode").project.settings,
      allowedShellCommands: ["npm run test"]
    };
    const policy = commandAllowedBySettings(settings, "npm run test", "/tmp/archicode");

    expect(policy?.command).toBe("npm run test");
    expect(policy?.reusable).toBe(true);
  });
});
