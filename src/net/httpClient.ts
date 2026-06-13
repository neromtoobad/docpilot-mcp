/**
 * Minimal HTTP client.
 *
 * AC-3 needs to fetch docs and registry JSON. The richer client
 * described in AC-9 (10 req/s per host, 3-retry exponential backoff,
 * 15 s timeout) lands on top of this in AC-9. For AC-3 we only need
 * `get` and `getJson` with a hard timeout.
 */
import { error as logError } from '../util/log.js';

export interface HttpClientOptions {
  /** Per-request timeout in ms. Default: 15000. */
  timeoutMs?: number;
  /** User-Agent string. Default: "docpilot-mcp/0.1.0". */
  userAgent?: string;
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

/** Transport-agnostic HTTP client interface used by AC-3 modules. */
export interface HttpClient {
  get(url: string): Promise<string>;
  getJson<T = unknown>(url: string): Promise<T>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT = 'docpilot-mcp/0.1.0';

/** Default HttpClient implementation backed by global `fetch`. */
export class FetchHttpClient implements HttpClient {
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: HttpClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  async get(url: string): Promise<string> {
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
      return await res.text();
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
