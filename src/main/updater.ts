export type AppUpdateStatus =
  | {
      status: "not-configured";
      currentVersion: string;
      message: string;
    }
  | {
      status: "up-to-date";
      currentVersion: string;
      latestVersion: string;
      releaseUrl?: string;
      downloadUrl?: string;
      message: string;
    }
  | {
      status: "available";
      currentVersion: string;
      latestVersion: string;
      releaseUrl?: string;
      downloadUrl?: string;
      message: string;
    }
  | {
      status: "failed";
      currentVersion: string;
      message: string;
    };

export type ReleaseMetadata = {
  version: string;
  releaseUrl?: string;
  downloadUrl?: string;
};

const UPDATE_FEED_URL = "";
const UPDATE_DOWNLOAD_URL = "";

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
    assets?: Array<{ browser_download_url?: unknown }>;
  };
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

export async function checkForAppUpdate(currentVersion: string, feedUrl = UPDATE_FEED_URL): Promise<AppUpdateStatus> {
  if (!feedUrl.trim()) {
    return {
      status: "not-configured",
      currentVersion,
      message: "Update checks are not configured yet. Add the GitHub latest-release endpoint before enabling app updates."
    };
  }

  try {
    const response = await fetch(feedUrl, {
      headers: {
        Accept: "application/vnd.github+json"
      }
    });
    if (!response.ok) {
      return {
        status: "failed",
        currentVersion,
        message: `Update check failed with HTTP ${response.status}.`
      };
    }
    const metadata = parseGitHubReleaseMetadata(await response.json());
    if (!metadata) {
      return {
        status: "failed",
        currentVersion,
        message: "Update check response did not include a release version."
      };
    }
    if (compareVersions(metadata.version, currentVersion) > 0) {
      return {
        status: "available",
        currentVersion,
        latestVersion: metadata.version.replace(/^v/i, ""),
        releaseUrl: metadata.releaseUrl,
        downloadUrl: metadata.downloadUrl,
        message: `ArchiCode ${metadata.version} is available.`
      };
    }
    return {
      status: "up-to-date",
      currentVersion,
      latestVersion: metadata.version.replace(/^v/i, ""),
      releaseUrl: metadata.releaseUrl,
      downloadUrl: metadata.downloadUrl,
      message: `ArchiCode is up to date (${currentVersion}).`
    };
  } catch (error) {
    return {
      status: "failed",
      currentVersion,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}
