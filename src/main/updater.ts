export type AppUpdateChannel = "github" | "windows-store";

export type AppUpdateStatus =
  | {
      status: "not-configured";
      currentVersion: string;
      releaseUrl?: string;
      updateChannel: AppUpdateChannel;
      message: string;
    }
  | {
      status: "up-to-date";
      currentVersion: string;
      latestVersion: string;
      releaseUrl?: string;
      downloadUrl?: string;
      updateChannel: AppUpdateChannel;
      message: string;
    }
  | {
      status: "available";
      currentVersion: string;
      latestVersion: string;
      releaseUrl?: string;
      downloadUrl?: string;
      updateChannel: AppUpdateChannel;
      message: string;
    }
  | {
      status: "failed";
      currentVersion: string;
      releaseUrl?: string;
      updateChannel: AppUpdateChannel;
      message: string;
    };

export type ReleaseMetadata = {
  version: string;
  releaseUrl?: string;
  downloadUrl?: string;
};

export const ARCHICODE_RELEASES_URL = "https://github.com/roymasad/ArchiCode/releases";
const UPDATE_FEED_URL = "https://api.github.com/repos/roymasad/ArchiCode/releases?per_page=100";
const UPDATE_TAGS_FEED_URL = "https://api.github.com/repos/roymasad/ArchiCode/tags?per_page=100";
const UPDATE_DOWNLOAD_URL = "";

type CheckForAppUpdateOptions = {
  windowsStore?: boolean;
};

function normalizeVersion(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => Number.isFinite(part) ? part : 0);
}

export function compareVersions(left: string, right: string): number {
  const leftParts = normalizeVersion(left);
  const rightParts = normalizeVersion(right);
  const length = Math.max(leftParts.length, rightParts.length, 3);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

export function parseGitHubReleaseMetadata(value: unknown, fallbackDownloadUrl = UPDATE_DOWNLOAD_URL): ReleaseMetadata | null {
  if (!value || typeof value !== "object") return null;
  const record = value as {
    tag_name?: unknown;
    name?: unknown;
    html_url?: unknown;
    draft?: unknown;
    assets?: Array<{ browser_download_url?: unknown }>;
  };
  if (record.draft === true) return null;
  const version = typeof record.tag_name === "string"
    ? record.tag_name
    : typeof record.name === "string"
      ? record.name
      : "";
  if (!version.trim()) return null;
  const assetUrl = record.assets?.find((asset) => typeof asset.browser_download_url === "string")?.browser_download_url;
  return {
    version,
    releaseUrl: typeof record.html_url === "string" ? record.html_url : undefined,
    downloadUrl: fallbackDownloadUrl || (typeof assetUrl === "string" ? assetUrl : undefined)
  };
}

export function parseGitHubReleasesMetadata(value: unknown, releaseUrl = ARCHICODE_RELEASES_URL): ReleaseMetadata | null {
  if (!Array.isArray(value)) return null;
  const releases = value
    .map((item) => {
      if (!item || typeof item !== "object" || typeof (item as { tag_name?: unknown }).tag_name !== "string") return null;
      return parseGitHubReleaseMetadata(item, releaseUrl);
    })
    .filter((metadata): metadata is ReleaseMetadata => metadata !== null && isVersionTag(metadata.version));
  if (!releases.length) return null;
  return releases.sort((left, right) => compareVersions(right.version, left.version))[0] ?? null;
}

function isVersionTag(tag: string): boolean {
  return /^v?\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?$/i.test(tag.trim());
}

export function parseGitHubTagsMetadata(value: unknown, releaseUrl = ARCHICODE_RELEASES_URL): ReleaseMetadata | null {
  if (!Array.isArray(value)) return null;
  const versions = value
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const name = (item as { name?: unknown }).name;
      return typeof name === "string" ? name.trim() : "";
    })
    .filter((name) => name && isVersionTag(name));
  if (!versions.length) return null;
  const [latest] = versions.sort((left, right) => compareVersions(right, left));
  return {
    version: latest,
    releaseUrl,
    downloadUrl: releaseUrl
  };
}

export async function checkForAppUpdate(
  currentVersion: string,
  feedUrl = UPDATE_FEED_URL,
  options: CheckForAppUpdateOptions = {}
): Promise<AppUpdateStatus> {
  const updateChannel: AppUpdateChannel = options.windowsStore ? "windows-store" : "github";
  if (!feedUrl.trim()) {
    return {
      status: "not-configured",
      currentVersion,
      releaseUrl: ARCHICODE_RELEASES_URL,
      updateChannel,
      message: "Update checks are not configured yet. Add the GitHub releases endpoint before enabling app updates."
    };
  }

  try {
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": `ArchiCode/${currentVersion}`
    };
    let usedTagFallback = false;
    let response = await fetch(feedUrl, {
      headers
    });
    if (!response.ok && response.status === 404 && feedUrl === UPDATE_FEED_URL) {
      usedTagFallback = true;
      response = await fetch(UPDATE_TAGS_FEED_URL, {
        headers
      });
    }
    if (!response.ok) {
      return {
        status: "failed",
        currentVersion,
        releaseUrl: ARCHICODE_RELEASES_URL,
        updateChannel,
        message: `Update check failed with HTTP ${response.status}.`
      };
    }
    const rawMetadata = await response.json();
    let metadata = Array.isArray(rawMetadata)
      ? usedTagFallback
        ? parseGitHubTagsMetadata(rawMetadata)
        : parseGitHubReleasesMetadata(rawMetadata)
      : parseGitHubReleaseMetadata(rawMetadata, ARCHICODE_RELEASES_URL);
    if (!metadata && feedUrl === UPDATE_FEED_URL && !usedTagFallback) {
      const tagResponse = await fetch(UPDATE_TAGS_FEED_URL, {
        headers
      });
      if (tagResponse.ok) {
        metadata = parseGitHubTagsMetadata(await tagResponse.json());
      }
    }
    if (!metadata) {
      return {
        status: "failed",
        currentVersion,
        releaseUrl: ARCHICODE_RELEASES_URL,
        updateChannel,
        message: "Update check response did not include a release version."
      };
    }
    const comparison = compareVersions(metadata.version, currentVersion);
    const latestVersion = comparison < 0 ? currentVersion : metadata.version.replace(/^v/i, "");
    if (comparison > 0) {
      return {
        status: "available",
        currentVersion,
        latestVersion,
        releaseUrl: metadata.releaseUrl,
        downloadUrl: metadata.downloadUrl,
        updateChannel,
        message: options.windowsStore
          ? `ArchiCode ${latestVersion} is available. This Windows Store build should be updated through Microsoft Store.`
          : `ArchiCode ${latestVersion} is available.`
      };
    }
    return {
      status: "up-to-date",
      currentVersion,
      latestVersion,
      releaseUrl: metadata.releaseUrl,
      downloadUrl: metadata.downloadUrl,
      updateChannel,
      message: options.windowsStore
        ? `ArchiCode is up to date (${currentVersion}). Microsoft Store will manage future updates for this installation.`
        : `ArchiCode is up to date (${currentVersion}).`
    };
  } catch (error) {
    return {
      status: "failed",
      currentVersion,
      releaseUrl: ARCHICODE_RELEASES_URL,
      updateChannel,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}
