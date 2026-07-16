import { describe, expect, it } from "vitest";
import { checkForAppUpdate, compareVersions, parseGitHubReleaseMetadata } from "../src/main/updater";

describe("app updater preparation", () => {
  it("compares semantic versions with optional v prefixes", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("v0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.0", "0.1.1")).toBe(-1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });

  it("parses GitHub latest release metadata", () => {
    const metadata = parseGitHubReleaseMetadata({
      tag_name: "v0.2.0",
      html_url: "https://github.com/example/archicode/releases/tag/v0.2.0",
      assets: [
        { browser_download_url: "https://github.com/example/archicode/releases/download/v0.2.0/ArchiCode.dmg" }
      ]
    });

    expect(metadata).toEqual({
      version: "v0.2.0",
      releaseUrl: "https://github.com/example/archicode/releases/tag/v0.2.0",
      downloadUrl: "https://github.com/example/archicode/releases/download/v0.2.0/ArchiCode.dmg"
    });
  });

  it("reports update checks as not configured until the release endpoint is wired", async () => {
    await expect(checkForAppUpdate("0.1.0", "")).resolves.toMatchObject({
      status: "not-configured",
      currentVersion: "0.1.0"
    });
  });
});
