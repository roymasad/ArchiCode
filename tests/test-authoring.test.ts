import { describe, expect, it } from "vitest";
import { resolveSafeProjectPath, parseTestAuthoringOutput } from "../src/main/microRunAgents/testAuthoring";

describe("test-authoring agent", () => {
  describe("resolveSafeProjectPath", () => {
    const root = "/Users/dev/project";

    it("accepts a normal project-relative path", () => {
      expect(resolveSafeProjectPath(root, "tests/about-page.test.ts")).toBe("/Users/dev/project/tests/about-page.test.ts");
    });

    it("rejects absolute paths", () => {
      expect(resolveSafeProjectPath(root, "/etc/passwd")).toBeNull();
    });

    it("rejects parent-directory traversal that escapes the project", () => {
      expect(resolveSafeProjectPath(root, "../other/evil.ts")).toBeNull();
      expect(resolveSafeProjectPath(root, "tests/../../escape.ts")).toBeNull();
    });

    it("rejects empty paths", () => {
      expect(resolveSafeProjectPath(root, "")).toBeNull();
    });

    it("allows internal traversal that stays inside the project", () => {
      expect(resolveSafeProjectPath(root, "src/a/../b/test.ts")).toBe("/Users/dev/project/src/b/test.ts");
    });
  });

  describe("parseTestAuthoringOutput", () => {
    it("derives checks (with test names) directly from self-describing write_test_file calls", () => {
      // One file covering two criteria, each bound to a distinct test name.
      const toolCalls = [
        { providerToolName: "write_test_file", argumentsJson: JSON.stringify({
          filePath: ".archicode/tests/about-page/about-page.test.ts",
          content: "...",
          checks: [
            { criterion: "About page reachable at /about", testName: "renders the /about route" },
            { criterion: "Nav links landing and about", testName: "navigation links both pages" }
          ],
          testCommand: "npx vitest run .archicode/tests/about-page/about-page.test.ts"
        }) }
        // note: no report_acceptance_tests call at all
      ];
      const output = parseTestAuthoringOutput("", toolCalls);
      expect(output.checks).toHaveLength(2);
      expect(output.checks[0]).toMatchObject({
        criterion: "About page reachable at /about",
        testFilePath: ".archicode/tests/about-page/about-page.test.ts",
        testName: "renders the /about route"
      });
      expect(output.checks[1].testName).toBe("navigation links both pages");
      expect(output.filesWritten).toContain(".archicode/tests/about-page/about-page.test.ts");
    });

    it("recovers authored checks and written files from tool calls", () => {
      const toolCalls = [
        { providerToolName: "write_test_file", argumentsJson: JSON.stringify({ filePath: "tests/about.test.ts", content: "..." }) },
        { providerToolName: "write_test_file", argumentsJson: JSON.stringify({ filePath: "tests/nav.test.ts", content: "..." }) },
        { providerToolName: "report_acceptance_tests", argumentsJson: JSON.stringify({
          checks: [
            { criterion: "About page reachable at /about", testFilePath: "tests/about.test.ts", testCommand: "npm test -- tests/about.test.ts" },
            { criterion: "Nav links both pages", testFilePath: "tests/nav.test.ts", testCommand: "npm test -- tests/nav.test.ts" }
          ],
          report: "Wrote 2 tests; skipped the visual-style criterion."
        }) }
      ];

      const output = parseTestAuthoringOutput("done", toolCalls);
      expect(output.checks).toHaveLength(2);
      expect(output.checks[0]).toMatchObject({ criterion: "About page reachable at /about", testFilePath: "tests/about.test.ts" });
      expect(output.filesWritten).toEqual(["tests/about.test.ts", "tests/nav.test.ts"]);
      expect(output.report).toContain("skipped the visual-style criterion");
    });

    it("drops malformed check entries", () => {
      const toolCalls = [
        { providerToolName: "report_acceptance_tests", argumentsJson: JSON.stringify({
          checks: [
            { criterion: "Valid", testFilePath: "tests/a.test.ts", testCommand: "npm test -- tests/a.test.ts" },
            { criterion: "Missing command", testFilePath: "tests/b.test.ts" },
            { testFilePath: "tests/c.test.ts", testCommand: "npm test" }
          ]
        }) }
      ];
      const output = parseTestAuthoringOutput("", toolCalls);
      expect(output.checks).toHaveLength(1);
      expect(output.checks[0].criterion).toBe("Valid");
    });

    it("returns no checks when the agent never reported", () => {
      expect(parseTestAuthoringOutput("I could not find a test framework.", []).checks).toEqual([]);
    });
  });
});
