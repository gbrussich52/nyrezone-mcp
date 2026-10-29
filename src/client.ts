// HTTP access for the two public hosts this server reads. Everything that touches
// the network goes through here so the politeness rules (User-Agent, cache,
// serialized requests, request cap, timeout, size cap) live in one place.

export const VERSION = '0.2.0';
export const REPO_URL = 'https://github.com/gbrussich52/nyrezone-mcp';

export type UpstreamKind = 'timeout' | 'http' | 'network' | 'rate_limited' | 'too_large' | 'parse';

export class UpstreamError extends Error {
  constructor(
    public readonly kind: UpstreamKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface ClientOptions {
  fetchImpl?: typeof fetch;
  /** Origin serving /api/pluto and /zoning pages. Overridable for tests only. */
  nyrezoneBase?: string;
  /** Origin serving the NYC Planning Labs Geosearch API. Overridable for tests only. */
  geosearchBase?: string;
  minIntervalMs?: number;
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxRequestsPerMinute?: number;
  maxBytes?: number;
  now?: () => number;
}

export interface FetchedText {
  status: number;
  body: string;
}

const MAX_CACHE = 500;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HttpClient {
  readonly nyrezoneBase: string;
  readonly geosearchBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly maxPerMinute: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; value: FetchedText }>();
  private readonly sent: number[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private lastSentAt = 0;

  constructor(opts: ClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.nyrezoneBase = (opts.nyrezoneBase ?? 'https://nyrezone.com').replace(/\/+$/, '');
    this.geosearchBase = (opts.geosearchBase ?? 'https://geosearch.planninglabs.nyc').replace(/\/+$/, '');
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.cacheTtlMs = opts.cacheTtlMs ?? 60 * 60 * 1000;
    this.maxPerMinute = opts.maxRequestsPerMinute ?? 20;
    this.maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
    this.now = opts.now ?? Date.now;
  }

  /** GET a URL (cached). 404 is returned as a value, not thrown; other non-2xx throw. */
  getText(url: string, accept: string): Promise<FetchedText> {
    const hit = this.cache.get(url);
    if (hit && this.now() - hit.at < this.cacheTtlMs) return Promise.resolve(hit.value);
    // Serialize so concurrent tool calls never burst the upstream hosts.
    const run = this.queue.then(() => this.fetchOnce(url, accept));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async fetchOnce(url: string, accept: string): Promise<FetchedText> {
    const cached = this.cache.get(url);
    if (cached && this.now() - cached.at < this.cacheTtlMs) return cached.value;

    const t = this.now();
    while (this.sent.length && t - this.sent[0] > 60_000) this.sent.shift();
    if (this.sent.length >= this.maxPerMinute) {
      throw new UpstreamError('rate_limited', `nyrezone-mcp is limiting itself to ${this.maxPerMinute} upstream requests per minute; try again shortly.`);
    }
    const wait = this.lastSentAt + this.minIntervalMs - t;
    if (wait > 0) await sleep(wait);
    this.lastSentAt = this.now();
    this.sent.push(this.lastSentAt);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: {
          'user-agent': `nyrezone-mcp/${VERSION} (+${REPO_URL}; read-only MCP client)`,
          accept,
        },
        signal: ctrl.signal,
      });
      if (res.status === 429) {
        throw new UpstreamError('rate_limited', 'The upstream service asked us to slow down (HTTP 429); try again in a minute.', 429);
      }
      // A redirect must not carry us (and our User-Agent) off the two hosts we were pointed at.
      if (res.url) {
        let origin = '';
        try { origin = new URL(res.url).origin; } catch { /* handled below */ }
        const allowed = [this.nyrezoneBase, this.geosearchBase].map((b) => new URL(b).origin);
        if (!allowed.includes(origin)) throw new UpstreamError('http', 'Upstream redirected to an unexpected host; response rejected.');
      }
      const body = await this.readCapped(res);
      if (res.status !== 404 && !res.ok) {
        throw new UpstreamError('http', `Upstream returned HTTP ${res.status}.`, res.status);
      }
      const value: FetchedText = { status: res.status, body };
      this.cache.set(url, { at: this.now(), value });
      this.evict();
      return value;
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      if (ctrl.signal.aborted) throw new UpstreamError('timeout', `Upstream did not answer within ${this.timeoutMs / 1000}s.`);
      throw new UpstreamError('network', 'Could not reach the upstream service.');
    } finally {
      clearTimeout(timer);
    }
  }

  /** Bound memory: past MAX_CACHE entries drop expired ones first, then the oldest. */
  private evict(): void {
    if (this.cache.size <= MAX_CACHE) return;
    const t = this.now();
    for (const [k, v] of this.cache) if (t - v.at >= this.cacheTtlMs) this.cache.delete(k);
    while (this.cache.size > MAX_CACHE) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  private async readCapped(res: Response): Promise<string> {
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > this.maxBytes) throw new UpstreamError('too_large', 'Upstream response is larger than the safety cap.');
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxBytes) {
        await reader.cancel();
        throw new UpstreamError('too_large', 'Upstream response is larger than the safety cap.');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}
