import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectTechStack } from "../src/main/techStack";

async function tmpProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "archicode-techstack-"));
}

describe("detectTechStack", () => {
  it("detects a JavaScript/npm project and infers commands from package.json scripts", async () => {
    const root = await tmpProject();
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest run", build: "vite build" }
    }), "utf8");
    await writeFile(path.join(root, "package-lock.json"), "{}", "utf8");
    await writeFile(path.join(root, "tsconfig.json"), "{}", "utf8");

    const stack = await detectTechStack(root);

    expect(stack.primaryLanguage).toBe("javascript");
    expect(stack.languages).toContain("typescript");
    expect(stack.packageManager).toBe("npm");
    expect(stack.buildTool).toBe("npm");
    expect(stack.typecheckTool).toBe("tsc");
    expect(stack.suggestedCommands).toMatchObject({
      typecheck: "npm run typecheck",
      lint: "npm run lint",
      test: "npm test",
      build: "npm run build"
    });
  });

  it("detects a Rust/cargo project and suggests cargo commands", async () => {
    const root = await tmpProject();
    await writeFile(path.join(root, "Cargo.toml"), "[package]\nname = \"demo\"\n", "utf8");
    await writeFile(path.join(root, "Cargo.lock"), "", "utf8");

    const stack = await detectTechStack(root);

    expect(stack.primaryLanguage).toBe("rust");
    expect(stack.packageManager).toBe("cargo");
    expect(stack.buildTool).toBe("cargo");
    expect(stack.lintTool).toBe("clippy");
    expect(stack.suggestedCommands).toMatchObject({
      typecheck: "cargo check",
      lint: "cargo clippy",
      test: "cargo test",
      build: "cargo build"
    });
  });

  it("detects a Python/poetry project with pyproject-declared tooling", async () => {
    const root = await tmpProject();
    await writeFile(path.join(root, "pyproject.toml"), "[tool.mypy]\n[tool.ruff]\n[tool.pytest.ini_options]\n", "utf8");
    await writeFile(path.join(root, "poetry.lock"), "", "utf8");

    const stack = await detectTechStack(root);

    expect(stack.primaryLanguage).toBe("python");
    expect(stack.packageManager).toBe("poetry");
    expect(stack.typecheckTool).toBe("mypy");
    expect(stack.lintTool).toBe("ruff");
    expect(stack.suggestedCommands).toMatchObject({
      typecheck: "mypy .",
      lint: "ruff check .",
      test: "pytest"
    });
  });

  it("falls back to unknown when no recognizable project files exist", async () => {
    const root = await tmpProject();
    await mkdir(path.join(root, "empty"), { recursive: true });

    const stack = await detectTechStack(root);

    expect(stack.primaryLanguage).toBe("unknown");
    expect(stack.languages).toEqual(["unknown"]);
    expect(stack.packageManager).toBeNull();
    expect(stack.buildTool).toBeNull();
  });
});
