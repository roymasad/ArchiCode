import { lookup } from "node:dns/promises";
import type { ResearchFetchedWebPage } from "../research";
import { guardedFetchText } from "../../shared/networkGuard";

export async function fetchResearchWebPages(message: string): Promise<ResearchFetchedWebPage[]> {
  const urls = extractResearchUrls(message).slice(0, 3);
  const pages: ResearchFetchedWebPage[] = [];
  for (const url of urls) {
    pages.push(await fetchResearchWebPage(url));
  }
  return pages;
}

export function extractResearchUrls(message: string): string[] {
  const matches = new Set<string>();
  const explicitPattern = /\bhttps?:\/\/[^\s<>()"'`]+/gi;
  const domainPattern = /(?<!@)\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<>()"'`]*)?/gi;
  for (const match of message.matchAll(explicitPattern)) {
    const normalized = normalizeResearchUrl(match[0]);
    if (normalized) matches.add(normalized);
  }
  for (const match of message.matchAll(domainPattern)) {
    const normalized = normalizeResearchUrl(match[0]);
    if (normalized) matches.add(normalized);
  }
  return Array.from(matches);
}

export function normalizeResearchUrl(raw: string): string | null {
  const cleaned = raw.trim().replace(/[.,;:!?)]*$/g, "");
  const withProtocol = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
  try {
    const url = new URL(withProtocol);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (isBlockedResearchHost(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function isBlockedResearchHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "0.0.0.0" || host === "::1") return true;
  if (host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.")) return true;
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part))) {
    const [first, second] = parts;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 169 && second === 254) return true;
  }
  return false;
}

export async function fetchResearchWebPage(url: string): Promise<ResearchFetchedWebPage> {
  try {
    const result = await guardedFetchText(url, (hostname) => lookup(hostname, { all: true }), {
      timeoutMs: 8000,
      headers: {
        "accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        "user-agent": "ArchiCode Research/0.1"
      }
    });
    const text = simplifyFetchedText(result.text, result.contentType).slice(0, 12000);
    return {
      url: result.finalUrl || url,
      status: result.status,
      title: extractHtmlTitle(result.text),
      contentType: result.contentType,
      text
    };
  } catch (error) {
    return {
      url,
      status: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function extractHtmlTitle(raw: string): string | undefined {
  const match = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtmlEntities(match[1].replace(/\s+/g, " ").trim()).slice(0, 220) : undefined;
}

export function simplifyFetchedText(raw: string, contentType?: string): string {
  if (contentType && !/(html|xml|text|json)/i.test(contentType)) {
    return `Fetched non-text content of type ${contentType}.`;
  }
  return decodeHtmlEntities(raw)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}
