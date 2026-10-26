import { CHECKS } from './checks.ts';
import { assertPublicUrl, createFetcher, type Fetcher, type FetcherOptions } from './fetcher.ts';
import { isOk, jsonLd, linkRel, parseSitemap } from './html.ts';
import { parseRobots } from './robots.ts';
import { score } from './score.ts';
import type { CheckResult, Platform, Probe, RefundReason, Res, ScanResult, Snapshot } from './types.ts';

const MD = { accept: 'text/markdown' };
const FEED_PATHS = ['/products.json?limit=1', '/wp-json/wc/store/v1/products?per_page=1', '/product-feed.xml', '/products.jsonld'];
const PROTOCOL_PATHS = ['/.well-known/ucp', '/.well-known/acp.json', '/.well-known/x402', '/.well-known/ap2.json', '/.well-known/agent-card.json', '/.well-known/mpp', '/openapi.json'];

async function probe(f: Fetcher, url: string, headers?: Record<string, string>, respectRobots = true): Promise<Probe> {
  return { url, res: (await f.get(url, { headers, maxBytes: 100_000, respectRobots })).res };
}

export async function collect(f: Fetcher, origin: string): Promise<Snapshot> {
  const at = (p: string) => origin + p;
  const home = await f.get(at('/'));
  const robots = (await f.get(at('/robots.txt'), { respectRobots: false })).res;

  // sitemap: robots.txt Sitemap: line first, then common paths
  const fromRobots = isOk(robots) && !/^\s*</.test(robots.body) ? parseRobots(robots.body).sitemaps[0] : undefined;
  let sitemapUrl: string | null = null;
  let sitemap: Res | null = null;
  for (const u of [fromRobots, at('/sitemap.xml'), at('/wp-sitemap.xml')].filter((x): x is string => !!x)) {
    const r = (await f.get(u)).res;
    if (r && !sitemap) {
      sitemapUrl = u;
      sitemap = r;
    }
    if (isOk(r) && parseSitemap(r.body).valid) {
      sitemapUrl = u;
      sitemap = r;
      break;
    }
  }

  // product page: from sitemap (or one child sitemap, preferring a product one)
  let childSitemap: Res | null = null;
  let productUrl: string | null = null;
  if (isOk(sitemap)) {
    const p = parseSitemap(sitemap.body);
    let entries = p.entries;
    if (p.isIndex) {
      const child = p.entries.find((e) => /product/i.test(e.loc)) ?? p.entries[0];
      if (child) {
        childSitemap = (await f.get(child.loc)).res;
        entries = isOk(childSitemap) ? parseSitemap(childSitemap.body).entries : [];
      } else entries = [];
    }
    productUrl = entries.find((e) => /\/products?\//i.test(e.loc))?.loc ?? null;
  }
  const product = productUrl ? (await f.get(productUrl)).res : null;

  const llms = (await f.get(at('/llms.txt'))).res;
  const llmsLinks: Probe[] = [];
  if (isOk(llms)) {
    const urls = [...new Set([...llms.body.matchAll(/\[[^\]]*\]\(\s*([^)\s]+)/g)].map((m) => m[1]))].slice(0, 10);
    for (const u of urls) {
      try {
        llmsLinks.push(await probe(f, new URL(u, origin).href));
      } catch {
        llmsLinks.push({ url: u, res: null });
      }
    }
  }

  const markdownAccept = (await f.get(at('/'), { headers: MD, maxBytes: 100_000 })).res;
  const indexMd = (await f.get(at('/index.md'), { maxBytes: 100_000 })).res;
  const productMd = productUrl ? (await f.get(productUrl.replace(/\/$/, '') + '.md', { maxBytes: 100_000 })).res : null;
  const pricingMd = (await f.get(at('/pricing.md'), { maxBytes: 100_000 })).res;
  const notFound = (await f.get(at(`/aeo-probe-${Math.random().toString(36).slice(2, 10)}`), { maxBytes: 100_000 })).res;
  const feeds = [];
  for (const p of FEED_PATHS) feeds.push(await probe(f, at(p)));
  // catalog advertised in the homepage Link header, e.g. </products.jsonld>; rel="describedby"
  const advertised = [...(home.res?.headers.link ?? '').matchAll(/<([^>]+)>\s*;[^,]*rel="?(?:describedby|alternate)"?/gi)]
    .map((m) => m[1])
    .filter((u) => /product|catalog|feed/i.test(u));
  for (const u of advertised.slice(0, 2)) {
    try {
      const url = new URL(u, origin);
      if (url.origin === origin && !feeds.some((x) => x.url === url.href)) feeds.push(await probe(f, url.href));
    } catch {}
  }
  const protocols = [];
  for (const p of PROTOCOL_PATHS) protocols.push(await probe(f, at(p)));
  // x402 / MPP are signalled by a 402 on a paid resource: probe the resources the x402 discovery document lists.
  const x402 = protocols.find((p) => p.url.endsWith('/.well-known/x402'));
  if (x402 && isOk(x402.res)) {
    try {
      const resources: unknown = JSON.parse(x402.res.body).resources;
      for (const u of (Array.isArray(resources) ? resources : []).filter((x): x is string => typeof x === 'string').slice(0, 3)) {
        if (new URL(u).origin === origin) protocols.push(await probe(f, u, undefined, false)); // the site advertises this URL for agents itself, even if robots.txt disallows /api/
      }
    } catch {}
  }

  return { origin, home: home.res, homeError: home.error, robots, sitemapUrl, sitemap, childSitemap, productUrl, product, llms, llmsLinks, markdownAccept, indexMd, productMd, pricingMd, notFound, feeds, protocols };
}

export function evaluate(s: Snapshot): CheckResult[] {
  return CHECKS.map((c) => ({ id: c.id, name: c.name, level: c.level, weight: c.weight, ...c.run(s) }));
}

/** Homepage markers only; anything unrecognised is a plain website. */
export function detectPlatform(s: Snapshot): Platform {
  const body = s.home?.body ?? '';
  const h = s.home?.headers ?? {};
  if (h['x-shopify-stage'] || h['x-shopid'] || /cdn\.shopify\.com|Shopify\.shop\b/.test(body)) return 'shopify';
  if (/\/wp-content\/|\/wp-includes\/|name=["']generator["'][^>]*WordPress/i.test(body) || /wp-json/.test(h.link ?? '')) return 'wordpress';
  return 'website';
}

function refundSignal(s: Snapshot, checks: CheckResult[]): ScanResult['refund'] {
  const no = { eligible: false, reason: null, detail: null };
  const out = (reason: RefundReason, detail: string) => ({ eligible: true, reason, detail });
  // Unreachable robots.txt is disallow-all, so a dead site must still report as unreachable, not robots-blocked.
  if (!s.robots && !s.home) return out('unreachable', s.homeError ?? 'homepage not reachable');
  if (s.homeError?.startsWith('blocked by robots.txt')) return out('blocked_by_robots', s.homeError);
  if (!s.home) return out('unreachable', s.homeError ?? 'homepage not reachable');
  if (s.home.status >= 500) return out('unreachable', `homepage returned ${s.home.status}`);
  if (checks.find((c) => c.id === 6)?.status === 'fail') return out('waf_blocked', checks.find((c) => c.id === 6)!.evidence);
  return no;
}

/** Organization logo from JSON-LD, else the best icon link; '' when the homepage has neither. */
export function siteLogo(home: Res | null, origin: string): string {
  if (!isOk(home)) return '';
  const abs = (v: unknown) => {
    if (typeof v !== 'string' || !v.trim()) return '';
    try {
      const u = new URL(v.trim(), home.url || origin);
      return /^https?:$/.test(u.protocol) ? u.href : '';
    } catch {
      return '';
    }
  };
  for (const n of jsonLd(home.body).nodes) {
    const l = n.logo;
    const url = abs(typeof l === 'object' && l ? (l as { url?: unknown }).url : l);
    if (url) return url;
  }
  const icons = [...linkRel(home.body, 'apple-touch-icon'), ...linkRel(home.body, 'icon')];
  return icons.map(abs).find(Boolean) ?? '';
}

/** `allowPrivate` is for local dev sites only; never set it from user input. */
export async function scan(input: string, opts: FetcherOptions & { allowPrivate?: boolean } = {}): Promise<ScanResult> {
  const full = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const url = opts.allowPrivate ? new URL(full) : assertPublicUrl(full);
  const fetcher = createFetcher(opts);
  const snapshot = await collect(fetcher, url.origin);
  const checks = evaluate(snapshot);
  return { url: url.href, origin: url.origin, platform: detectPlatform(snapshot), scannedAt: new Date().toISOString(), checks, score: score(checks), logo: siteLogo(snapshot.home, url.origin), refund: refundSignal(snapshot, checks), rateLimited: fetcher.stats.rateLimited > 0 };
}
