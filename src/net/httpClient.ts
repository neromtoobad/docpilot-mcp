/**
 * Minimal HTTP client with SSRF protection, configurable timeout,
 * response-size cap, and retry-friendly error classification.
 *
 * AC-3 needs to fetch docs and registry JSON. Hardening:
 *   - Rejects non-http(s) protocols.
 *   - Blocks private/loopback IP addresses and .local domains to
 *     prevent SSRF when the server fetches caller-supplied URLs.
 *   - Caps response body at `maxResponseBytes` to prevent OOM.
 *   - Reads `DOCPILOT_USER_AGENT` env var so operators can customise
 *     the User-Agent without rebuilding.
 */
import { error as logError } from '../util/log.js';

export interface HttpClientOptions {
  /** Per-request timeout in ms. Default: 15 000. */
  timeoutMs?: number;
  /** User-Agent string. Default: env DOCPILOT_USER_AGENT or "docpilot-mcp/0.1.0". */
  userAgent?: string;
  /** Maximum response body size in bytes. Default: 5 MB. */
  maxResponseBytes?: number;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Transport-agnostic HTTP client interface used by tool modules. */
export interface HttpClient {
  get(url: string): Promise<string>;
  getJson<T = unknown>(url: string): Promise<T>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT =
  process.env.DOCPILOT_USER_AGENT ?? 'docpilot-mcp/0.1.0';
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Regex that matches hostnames/IPs that must never be reached from an
 * internet-facing server (loopback, link-local, RFC-1918, .local mDNS).
 * Guards against SSRF when fetching user-supplied or registry-provided URLs.
 */
const PRIVATE_HOST_RE =
  /^(?:localhost|.*\.local)$|^127\.|^10\.|^172\.(?:1[6-9]|2\d|3[01])\.|^192\.168\.|^169\.254\.|^::1$|^\[::1\]/i;

/** Validate a URL before fetching — throws `HttpError` on violation. */
function validateUrl(urlStr: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new HttpError(`Invalid URL: ${urlStr}`, 0, urlStr);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new HttpError(
      `Blocked non-HTTP(S) URL (protocol=${parsed.protocol}): ${urlStr}`,
      0,
      urlStr,
    );
  }
  if (PRIVATE_HOST_RE.test(parsed.hostname)) {
    throw new HttpError(
      `Blocked private/loopback host (SSRF guard): ${parsed.hostname}`,
      0,
      urlStr,
    );
  }
}

/** Default HttpClient implementation backed by global `fetch`. */
export class FetchHttpClient implements HttpClient {
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly maxResponseBytes: number;

  constructor(options: HttpClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  async get(url: string): Promise<string> {
    validateUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'text/html, application/json;q=0.9, */*;q=0.5',
        },
        redirect: 'follow',
      });
      if (!res.ok) {
        throw new HttpError(`HTTP ${res.status} ${res.statusText} for ${url}`, res.status, url);
      }
      // Guard against memory exhaustion from unexpectedly large responses.
      const contentLength = Number(res.headers.get('content-length') ?? 0);
      if (contentLength > this.maxResponseBytes) {
        throw new HttpError(
          `Response too large (${contentLength} bytes, max ${this.maxResponseBytes}) for ${url}`,
          0,
          url,
        );
      }
      const text = await res.text();
      if (text.length > this.maxResponseBytes) {
        return text.slice(0, this.maxResponseBytes);
      }
      return text;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      logError(`fetch failed for ${url}: ${message}`);
      throw new HttpError(`fetch failed for ${url}: ${message}`, 0, url);
    } finally {
      clearTimeout(timer);
    }
  }

  async getJson<T = unknown>(url: string): Promise<T> {
    const text = await this.get(url);
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpError(`invalid JSON from ${url}: ${message}`, 200, url);
    }
  }
}
