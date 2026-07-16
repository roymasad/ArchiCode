// Network destination guard shared by the in-process internal tools and the
// generated stdio MCP server. Both agent surfaces (chat/research and build)
// fetch URLs the model chooses, so a prompt-injected repo or web page could aim
// a request at the machine's own trusted network position (SSRF). We classify
// the *resolved* destination — not just literal-IP syntax — and re-check on
// every redirect hop.
//
// Tiers:
//   loopback   (127.0.0.0/8, ::1)                       -> allow (dev-server troubleshooting)
//   link-local (169.254.0.0/16, fe80::/10) incl. cloud
//              metadata 169.254.169.254                 -> hard-block, always
//   private    (10/8, 172.16/12, 192.168/16, CGNAT,
//              IPv6 ULA fc00::/7)                        -> block (no legit use for a local project)
//   public     (everything else)                        -> allow

export type NetworkDestinationCategory = "loopback" | "link-local" | "private" | "public";

export type NetworkDestinationDecision = {
  allowed: boolean;
  category: NetworkDestinationCategory;
  reason?: string;
};

export function classifyIpAddress(address: string): NetworkDestinationCategory {
  const raw = (address || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!raw) return "public";

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — classify by the embedded v4 address.
  const mapped = raw.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const candidate = mapped ? mapped[1] : raw;

  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(candidate)) {
    const parts = candidate.split(".").map((part) => Number(part));
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return "public";
    const [a, b] = parts;
    if (a === 127) return "loopback";
    if (a === 169 && b === 254) return "link-local";
    if (a === 10) return "private";
    if (a === 172 && b >= 16 && b <= 31) return "private";
    if (a === 192 && b === 168) return "private";
    if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT (RFC 6598)
    if (a === 0) return "private"; // "this host" / unspecified
    return "public";
  }

  // IPv6.
  if (raw === "::1") return "loopback";
  if (raw === "::" ) return "private";
  if (/^fe80:/.test(raw)) return "link-local"; // link-local unicast (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/.test(raw)) return "private"; // unique local (fc00::/7), incl. IMDSv6 fd00:ec2::254
  return "public";
}

export function decideDestinationCategory(category: NetworkDestinationCategory, hostname: string): NetworkDestinationDecision {
  if (category === "link-local") {
    return {
      allowed: false,
      category,
      reason: "Blocked link-local/cloud-metadata address for " + hostname + ". This range (169.254.0.0/16, fe80::/10) is never a valid target for a local project."
    };
  }
  if (category === "private") {
    return {
      allowed: false,
      category,
      reason: "Blocked private/LAN address for " + hostname + ". Fetching private-network hosts requires explicit configuration."
    };
  }
  return { allowed: true, category };
}

// Resolves the hostname to every address it maps to and returns the most
// restrictive decision, so a name that resolves to both a public and a private
// record (a rebinding trick) is still blocked.
export async function evaluateUrlDestination(
  urlString: string,
  lookupAll: (hostname: string) => Promise<{ address: string }[]>
): Promise<NetworkDestinationDecision> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { allowed: false, category: "public", reason: "Invalid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, category: "public", reason: "Only http and https URLs are supported." };
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    const resolved = await lookupAll(hostname);
    addresses = resolved.map((entry) => entry.address).filter(Boolean);
  } catch {
    return { allowed: false, category: "public", reason: "Could not resolve host " + hostname + "." };
  }
  if (!addresses.length) return { allowed: false, category: "public", reason: "Host " + hostname + " resolved to no addresses." };

  const order: NetworkDestinationCategory[] = ["link-local", "private", "loopback", "public"];
  let worst: NetworkDestinationCategory = "public";
  for (const address of addresses) {
    const category = classifyIpAddress(address);
    if (order.indexOf(category) < order.indexOf(worst)) worst = category;
  }
  return decideDestinationCategory(worst, hostname);
}

export type GuardedFetchResult = { status: number; contentType?: string; text: string; finalUrl: string };

// Fetches a URL while validating the destination on the initial request and on
// every redirect hop (Location can bounce a public URL into private space).
export async function guardedFetchText(
  urlString: string,
  lookupAll: (hostname: string) => Promise<{ address: string }[]>,
  options: { headers?: Record<string, string>; timeoutMs?: number; maxRedirects?: number } = {}
): Promise<GuardedFetchResult> {
  const maxRedirects = options.maxRedirects ?? 4;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const headers = options.headers ?? { "user-agent": "ArchiCode/0.1" };
  let current = urlString;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const decision = await evaluateUrlDestination(current, lookupAll);
    if (!decision.allowed) throw new Error(decision.reason || "Network destination is blocked.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(current, { signal: controller.signal, headers, redirect: "manual" });
    } finally {
      clearTimeout(timeout);
    }
    const contentType = response.headers.get("content-type") ?? undefined;
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        current = new URL(location, current).toString();
        continue;
      }
    }
    return { status: response.status, contentType, text: await response.text(), finalUrl: response.url || current };
  }
  throw new Error("Too many redirects while fetching the requested URL.");
}

// Emits the guard as standalone JS for the generated stdio MCP server, so the
// in-process tools and the embedded server share one source of truth. The
// embedding scope must import `lookup` from "node:dns/promises".
export function embeddedNetworkGuardSource(): string {
  return [
    classifyIpAddress.toString(),
    decideDestinationCategory.toString(),
    evaluateUrlDestination.toString(),
    guardedFetchText.toString(),
    "const __archicodeLookupAll = (hostname) => lookup(hostname, { all: true });"
  ].join("\n\n");
}
