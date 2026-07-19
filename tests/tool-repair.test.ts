import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isRepairableProjectToolError,
  normalizeProjectToolArguments,
  repairableProjectToolResult
} from "../src/shared/toolRepair";

describe("project-scoped tool argument repair", () => {
  it("normalizes absolute console cwd values inside the project", () => {
    const projectRoot = path.resolve("/tmp/archicode-console-project");
    const rootResult = normalizeProjectToolArguments(
      projectRoot,
      "archicode_console_run_command",
      JSON.stringify({ command: "npm exec vue-tsc -- --noEmit", cwd: projectRoot, timeoutMs: 30_000 })
    );
    const nestedResult = normalizeProjectToolArguments(
      projectRoot,
      "archicode_console_run_command",
      JSON.stringify({ command: "npm test", cwd: path.join(projectRoot, "packages/web") })
    );

    expect(rootResult.changed).toBe(true);
    expect(JSON.parse(rootResult.argumentsJson)).toMatchObject({ cwd: "." });
    expect(JSON.parse(nestedResult.argumentsJson)).toMatchObject({ cwd: "packages/web" });
  });

  it("returns retry guidance instead of making an invalid console cwd fatal", () => {
    const error = new Error("Console tool cwd must be project-relative.");

    expect(isRepairableProjectToolError("archicode_console_run_command", error)).toBe(true);
    expect(repairableProjectToolResult("archicode_console_run_command", error)).toContain("Retry the same finite command");
  });

  it("redirects rejected read-only CLI execution attempts to Delphi without failing chat", () => {
    const error = new Error("npm run is not allowed in the read-only CLI tool.");

    expect(isRepairableProjectToolError("archicode_project_inspect_cli", error)).toBe(true);
    expect(repairableProjectToolResult("archicode_project_inspect_cli", error)).toContain("archicode_spawn_delphi");
  });
});
