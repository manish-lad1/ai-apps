/**
 * Server-side URL fetch + readable-content extraction, with an SSRF guard.
 *
 * The SSRF guard is the important part and is NOT optional. This endpoint takes
 * an arbitrary URL from an untrusted user and fetches it from *our* server —
 * which sits inside a network the user can't otherwise reach. Without a guard,
 * a user could point it at http://169.254.169.254 (the cloud metadata endpoint,
 * which hands out IAM credentials), at http://localhost:<port> to probe internal
 * services, or at any RFC-1918 address to scan the private network. So before we
 * fetch anything we resolve the hostname and refuse private/reserved IPs — and
 * we re-check on every redirect hop, because a public URL can 302 to an internal
 * one (a classic bypass).
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const MAX_CONTENT_BYTES = 2 * 1024 * 1024; // 2MB — avoid pathological pages
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;

export type ExtractedPage = {
  title: string;
  text: string;
  url: string;
};

/** Thrown for anything the user should see a clean message about. */
export class UrlFetchError extends Error {}

/** True if an IP literal falls in a private, loopback, or otherwise reserved range. */
export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIpv4(ip);
  if (kind === 6) return isPrivateIpv6(ip);
  return true; // not a parseable IP → treat as unsafe
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0]; // strip any zone id
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  if (addr.startsWith("fe80")) return true; // fe80::/10 link-local
  // fc00::/7 unique-local (fc.. and fd..)
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true;
  // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4 address too.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

/** Validate a single URL: scheme must be http(s) and the host must not resolve to a private IP. */
async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UrlFetchError("That doesn't look like a valid URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UrlFetchError("Only http and https URLs are supported.");
  }

  // If the host is already an IP literal, check it directly. Otherwise resolve
  // it — and check *every* address it resolves to, since a single hostname can
  // map to both a public and a private address.
  const host = parsed.hostname;
  const literal = isIP(host);
  if (literal) {
    if (isPrivateIp(host)) {
      throw new UrlFetchError(
        "That address is a private/internal one, which is blocked for security (SSRF protection)."
      );
    }
    return parsed;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new UrlFetchError(`Couldn't resolve the host "${host}".`);
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a.address))) {
    throw new UrlFetchError(
      "That host resolves to a private/internal address, which is blocked for security (SSRF protection)."
    );
  }

  return parsed;
}

/**
 * Fetch a URL following redirects manually, re-validating every hop against the
 * SSRF guard, and enforcing the size/content-type caps. Returns the raw HTML.
 */
async function safeFetchHtml(startUrl: string): Promise<{ html: string; finalUrl: string }> {
  let currentUrl = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(currentUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(currentUrl, {
        redirect: "manual", // we follow redirects ourselves so we can re-check each hop
        signal: controller.signal,
        headers: {
          // A UA string; some sites 403 an empty one.
          "User-Agent": "knowledge_base_rag/0.1 (+https://github.com/manish-lad1/ai-apps)",
          Accept: "text/html,application/xhtml+xml",
        },
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new UrlFetchError("The request timed out while fetching that URL.");
      }
      throw new UrlFetchError("Couldn't reach that URL.");
    } finally {
      clearTimeout(timer);
    }

    // Handle redirects ourselves.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new UrlFetchError(`Got a ${res.status} redirect with no location.`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (!res.ok) {
      throw new UrlFetchError(
        `The page returned HTTP ${res.status}. It may be private, removed, or blocking automated fetches.`
      );
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      throw new UrlFetchError(
        `That URL isn't an HTML page (content-type: ${contentType || "unknown"}). Only web articles are supported.`
      );
    }

    const html = await readCapped(res, MAX_CONTENT_BYTES);
    return { html, finalUrl: currentUrl };
  }

  throw new UrlFetchError("Too many redirects.");
}

/** Read a response body, aborting if it exceeds `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new UrlFetchError("That page is larger than the 2MB limit.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Fetch a URL and extract its readable article text (stripping nav, ads,
 * footers, etc.) via Mozilla's Readability — the same engine behind Firefox
 * Reader View.
 */
export async function fetchAndExtract(rawUrl: string): Promise<ExtractedPage> {
  const { html, finalUrl } = await safeFetchHtml(rawUrl);

  const dom = new JSDOM(html, { url: finalUrl });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  const text = (article?.textContent ?? "").trim();
  if (text.length < 200) {
    // Readability found little/no prose — almost always a JS-rendered SPA, a
    // paywall, or a login screen. Say so plainly rather than storing a stub.
    throw new UrlFetchError(
      "Couldn't extract readable text from that page. It may be a JavaScript-rendered app, a paywall, or a login page."
    );
  }

  return {
    title: article?.title?.trim() || finalUrl,
    text,
    url: finalUrl,
  };
}
