import { afterEach, describe, expect, it, vi } from "vitest";
import { ARCHICODE_RELEASES_URL, checkForAppUpdate, compareVersions, parseGitHubReleaseMetadata, parseGitHubReleasesMetadata, parseGitHubTagsMetadata } from "../src/main/updater";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("parses the newest semantic GitHub tag metadata", () => {
    const metadata = parseGitHubTagsMetadata([
      { name: "v0.3.5" },
      { name: "v0.10.0" },
      { name: "docs-refresh" }
    ]);

    expect(metadata).toEqual({
      version: "v0.10.0",
      releaseUrl: ARCHICODE_RELEASES_URL,
      downloadUrl: ARCHICODE_RELEASES_URL
    });
  });

  it("parses prereleases from the GitHub releases list", () => {
    const metadata = parseGitHubReleasesMetadata([
      {
        tag_name: "v0.3.5",
        name: "v0.3.5",
        html_url: "https://github.com/roymasad/ArchiCode/releases/tag/v0.3.5",
        prerelease: true
      },
      {
        tag_name: "v0.3.4",
        name: "v0.3.4",
        html_url: "https://github.com/roymasad/ArchiCode/releases/tag/v0.3.4",
        prerelease: false
      }
    ]);

    expect(metadata).toEqual({
      version: "v0.3.5",
      releaseUrl: "https://github.com/roymasad/ArchiCode/releases/tag/v0.3.5",
      downloadUrl: ARCHICODE_RELEASES_URL
    });
  });

  it("reports update checks as not configured until the release endpoint is wired", async () => {
    await expect(checkForAppUpdate("0.1.0", "")).resolves.toMatchObject({
      status: "not-configured",
      currentVersion: "0.1.0",
      updateChannel: "github"
    });
  });

  it("reports when a newer GitHub release is available", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          tag_name: "v0.4.0",
          html_url: "https://github.com/roymasad/ArchiCode/releases/tag/v0.4.0",
          prerelease: true
        }
      ]
    })));

    await expect(checkForAppUpdate("0.3.5")).resolves.toMatchObject({
      status: "available",
      currentVersion: "0.3.5",
      latestVersion: "0.4.0",
      releaseUrl: "https://github.com/roymasad/ArchiCode/releases/tag/v0.4.0",
      updateChannel: "github"
    });
  });

  it("reports when the installed version already matches the latest release", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          tag_name: "v0.3.5",
          html_url: "https://github.com/roymasad/ArchiCode/releases/tag/v0.3.5",
          prerelease: true
        }
      ]
    })));

    await expect(checkForAppUpdate("0.3.5")).resolves.toMatchObject({
      status: "up-to-date",
      currentVersion: "0.3.5",
      latestVersion: "0.3.5",
      releaseUrl: "https://github.com/roymasad/ArchiCode/releases/tag/v0.3.5",
      updateChannel: "github"
    });
  });

  it("does not display an older release as latest when the installed version is newer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          tag_name: "v0.3.4",
          html_url: "https://github.com/roymasad/ArchiCode/releases/tag/v0.3.4",
          prerelease: false
        }
      ]
    })));

    await expect(checkForAppUpdate("0.3.5")).resolves.toMatchObject({
      status: "up-to-date",
      currentVersion: "0.3.5",
      latestVersion: "0.3.5",
      releaseUrl: "https://github.com/roymasad/ArchiCode/releases/tag/v0.3.4",
      updateChannel: "github"
    });
  });

  it("falls back to tags when the repo has no GitHub releases yet", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ message: "Not Found" })
    } as Response);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        { name: "v0.3.5" }
      ]
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkForAppUpdate("0.3.5")).resolves.toMatchObject({
      status: "up-to-date",
      currentVersion: "0.3.5",
      latestVersion: "0.3.5",
      releaseUrl: ARCHICODE_RELEASES_URL,
      updateChannel: "github"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.github.com/repos/roymasad/ArchiCode/tags?per_page=100");
  });

  it("routes Windows Store builds back to Microsoft Store updates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          tag_name: "v0.4.0",
          html_url: "https://github.com/roymasad/ArchiCode/releases/tag/v0.4.0",
          prerelease: true
        }
      ]
    })));

    await expect(checkForAppUpdate("0.3.5", undefined, { windowsStore: true })).resolves.toMatchObject({
      status: "available",
      latestVersion: "0.4.0",
      updateChannel: "windows-store",
      message: expect.stringContaining("Microsoft Store")
    });
  });
});
