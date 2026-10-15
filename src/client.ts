/**
 * Minimal HTTP client for the newsapi.ai / Event Registry REST API.
 *
 * All endpoints take a JSON POST body; the API key travels in the body as `apiKey`.
 * Docs: https://newsapi.ai/documentation
 */

export class NewsApiError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
    this.name = "NewsApiError";
  }
}

export interface ClientOptions {
  apiKey: string;
  host?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** If set, every request is restricted to the last N days (7 or 31) — avoids archive token costs. */
  maxDataTimeWindow?: number;
  /** Where the key came from – only used to make auth errors actionable. */
  keySource?: string;
}

export class NewsApiClient {
  readonly host: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxDataTimeWindow?: number;
  private readonly keySource?: string;

  constructor(opts: ClientOptions) {
    if (!opts.apiKey) throw new NewsApiError("No newsapi.ai API key configured (set NEWSAPI_AI_KEY).");
    this.apiKey = opts.apiKey;
    this.host = (opts.host || "https://eventregistry.org").replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxDataTimeWindow = opts.maxDataTimeWindow;
    this.keySource = opts.keySource;
  }

  async request<T = any>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!path.startsWith("/api/v1/")) throw new NewsApiError(`Invalid path "${path}" – must start with /api/v1/`);
    const body: Record<string, unknown> = { ...stripUndefined(params), apiKey: this.apiKey };
    if (this.maxDataTimeWindow && body.forceMaxDataTimeWindow === undefined) {
      body.forceMaxDataTimeWindow = this.maxDataTimeWindow;
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(this.host + path, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "newsapi-ai-mcp" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        const text = await res.text();
        if (res.status === 429 || res.status >= 500) {
          lastErr = new NewsApiError(`newsapi.ai returned HTTP ${res.status}`, res.status, text.slice(0, 500));
          continue;
        }
        if (res.status === 401 || res.status === 403) {
          throw new NewsApiError(
            `newsapi.ai rejected the API key${this.keySource ? ` (taken from ${this.keySource})` : ""}: ${redact(text.slice(0, 300), this.apiKey)}`,
            res.status,
          );
        }
        if (!res.ok) {
          throw new NewsApiError(`newsapi.ai returned HTTP ${res.status}: ${redact(text.slice(0, 500), this.apiKey)}`, res.status);
        }
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          lastErr = new NewsApiError("newsapi.ai returned invalid JSON", res.status, text.slice(0, 500));
          continue;
        }
        if (json && typeof json === "object" && !Array.isArray(json) && json.error) {
          throw new NewsApiError(`newsapi.ai error: ${redact(stringify(json.error), this.apiKey)}`);
        }
        return json as T;
      } catch (err) {
        if (err instanceof NewsApiError) throw err;
        lastErr = err; // network error / timeout → retry
      } finally {
        clearTimeout(timer);
      }
    }
    if (lastErr instanceof NewsApiError) throw lastErr;
    throw new NewsApiError(`Request to newsapi.ai failed: ${(lastErr as Error)?.message ?? String(lastErr)}`);
  }
}

export function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stringify = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
const redact = (s: string, key: string) => (key ? s.split(key).join("***") : s);
