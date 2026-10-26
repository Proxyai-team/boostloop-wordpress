import { parseRobots, robotsAllows, type Robots } from './robots.ts';
import type { Fetched, Res } from './types.ts';
import type { BotSigner } from './webbotauth.ts';

export const BOT_TOKEN = 'BoostloopAEO';
export const USER_AGENT = `${BOT_TOKEN}/1.0 (+https://boostloop.club/bot)`;

export interface FetcherOptions {
  fetchImpl?: typeof fetch;
  /** Min ms between requests to the same host. */
  gapMs?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Local dev sites only; skips the public-host check on redirects. */
  allowPrivate?: boolean;
  /** Web Bot Auth: signs every request with BoostLoop's registered key. */
  signer?: BotSigner | null;
  /** Extra headers for one site only, by host: the merchant's own crawler signature (for example Shopify's). Never sent to other hosts, including redirect targets. */
  siteHeaders?: Record<string, Record<string, string>>;
}

// RFC 9309 §2.3.1.4: robots.txt unreachable (5xx, network or timeout) means disallow everything.
const DISALLOW_ALL: Robots = { groups: [{ agents: ['*'], rules: [{ allow: false, path: '/' }] }], sitemaps: [], contentSignals: [] };

export function assertPublicUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) URLs are allowed');
  // URL keeps the brackets on IPv6 hosts; strip them so the address checks see the bare address.
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateAddr = h.includes(':') ? privateIpv6(h) : privateIpv4(h);
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || privateAddr || (!h.includes('.') && !h.includes(':'))) throw new Error('host is not public');
  return u;
}

/** Loopback, private (RFC 1918), link-local, CGNAT 100.64.0.0/10, 0.0.0.0/8, reserved and multicast. */
function privateIpv4(h: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Two 16-bit groups as dotted IPv4. */
const ipv4From = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/** Unspecified and loopback fall under the mapped/compatible check (::, ::1 => 0.0.0.x). */
function privateIpv6(h: string): boolean {
  const g = ipv6Groups(h);
  if (!g) return true;
  const embedded = g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0);
  if (embedded) return privateIpv4(ipv4From(g[6], g[7]));
  if (g[0] === 0x2002) return privateIpv4(ipv4From(g[1], g[2])); // 6to4 embeds IPv4 in groups 2-3
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80; // unique-local fc00::/7, link-local fe80::/10
}

/** Expands a compressed IPv6 address to eight 16-bit groups; null if malformed. */
function ipv6Groups(h: string): number[] | null {
  const sides = h.split('::');
  if (sides.length > 2) return null;
  const head = sides[0] ? sides[0].split(':') : [];
  const tail = sides[1] ? sides[1].split(':') : [];
  const zeros = sides.length === 2 ? 8 - head.length - tail.length : 0;
  if (zeros < 0) return null;
  const groups = [...head, ...Array<string>(zeros).fill('0'), ...tail].map((p) => parseInt(p, 16));
  return groups.length === 8 && groups.every((x) => x >= 0 && x <= 0xffff) ? groups : null;
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(size, max));
  let off = 0;
  for (const c of chunks) {
    const part = c.subarray(0, all.length - off);
    all.set(part, off);
    off += part.length;
    if (off >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

/** Robots-aware, per-host rate-limited, redirect-limited fetcher using our own UA. */
export function createFetcher(opts: FetcherOptions = {}) {
  const doFetch = opts.fetchImpl ?? fetch;
  const gap = opts.gapMs ?? 1000;
  const maxRedirects = opts.maxRedirects ?? 5;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const lastAt = new Map<string, number>();
  const robots = new Map<string, Robots | null>();

  async function throttle(host: string) {
    const wait = (lastAt.get(host) ?? 0) + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt.set(host, Date.now());
  }

  /** Responses that were 429 or 503 with Retry-After: the site is throttling us. */
  const stats = { rateLimited: 0 };

  async function once(url: string, headers: Record<string, string>): Promise<Response> {
    const u = new URL(url);
    await throttle(u.host);
    // A merchant's own signature wins over ours: it is the one their platform asked for.
    const identity = opts.siteHeaders?.[u.host] ?? (opts.signer ? await opts.signer.sign(u) : {});
    const resp = await doFetch(url, { redirect: 'manual', headers: { 'user-agent': USER_AGENT, accept: '*/*', ...identity, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    if (resp.status === 429 || (resp.status === 503 && resp.headers.has('retry-after'))) stats.rateLimited++;
    return resp;
  }

  async function robotsFor(origin: string): Promise<Robots | null> {
    if (robots.has(origin)) return robots.get(origin)!;
    let parsed: Robots | null = null;
    try {
      // Same redirect handling as pages: apex/www and http/https hops must not skip the rules.
      // 4xx or missing = no rules; unreachable or 5xx = disallow all.
      const { res } = await get(origin + '/robots.txt', { respectRobots: false });
      if (!res || res.status >= 500) parsed = DISALLOW_ALL;
      else if (res.status >= 200 && res.status < 300 && !/^\s*</.test(res.body)) parsed = parseRobots(res.body);
    } catch {
      parsed = DISALLOW_ALL;
    }
    robots.set(origin, parsed);
    return parsed;
  }

  /** `respectRobots: false` only for robots.txt itself. */
  async function get(url: string, o: { headers?: Record<string, string>; maxBytes?: number; respectRobots?: boolean } = {}): Promise<Fetched> {
    let current = url;
    let hops = 0;
    for (;;) {
      const u = new URL(current);
      if (o.respectRobots !== false) {
        const r = await robotsFor(u.origin);
        if (r && !robotsAllows(r, BOT_TOKEN, u.pathname + u.search)) return { res: null, error: `blocked by robots.txt: ${u.pathname}` };
      }
      let resp: Response;
      try {
        resp = await once(current, o.headers ?? {});
      } catch (e) {
        return { res: null, error: e instanceof Error ? e.message : String(e) };
      }
      const location = resp.headers.get('location');
      if (resp.status >= 300 && resp.status < 400 && location) {
        resp.body?.cancel().catch(() => {});
        let next: URL;
        try {
          next = opts.allowPrivate ? new URL(location, current) : assertPublicUrl(new URL(location, current).href);
        } catch {
          return { res: null, error: `bad redirect target: ${location}` };
        }
        if (hops >= maxRedirects) return { res: { url: current, status: resp.status, headers: Object.fromEntries(resp.headers), body: '', redirects: hops }, error: 'too many redirects' };
        hops++;
        current = next.href;
        continue;
      }
      let body = '';
      try {
        body = await readCapped(resp, o.maxBytes ?? maxBytes);
      } catch {
        /* partial body treated as empty */
      }
      const res: Res = { url: current, status: resp.status, headers: Object.fromEntries([...resp.headers].map(([k, v]) => [k.toLowerCase(), v])), body, redirects: hops };
      return { res };
    }
  }

  return { get, stats };
}

export type Fetcher = ReturnType<typeof createFetcher>;
