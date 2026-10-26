import { SEARCH_BOTS } from './checks.ts';
import { createFetcher, assertPublicUrl, type Fetcher, type FetcherOptions } from './fetcher.ts';
import { anchors, visibleText, decode, isHtml, isOk, jsonLd, linkRel, meta, parseSitemap, tags, title, typesOf } from './html.ts';
import { parseRobots, type Robots } from './robots.ts';
import { collect, detectPlatform } from './scan.ts';
import type { Platform, Snapshot } from './types.ts';

export interface SitePage {
  url: string;
  title: string;
  description: string;
  markdown: string;
  head: PageHead;
}

/** What the page's <head> already has, so the wp_head fixes (checks 8, 10) only add what is missing. */
export interface PageHead {
  canonical: boolean;
  ogTitle: boolean;
  ogImage: boolean;
  /** og:image, else the first <img>; absolute, '' when none. */
  image: string;
  /** JSON-LD @types already on the page. */
  types: string[];
  /** Set on product pages (`/product(s)/` path or og:type product); price from product:price meta, '' when absent. */
  product: { price: string; currency: string } | null;
}

export interface SiteContent {
  origin: string;
  platform: Platform;
  /** Parsed from the merchant's current robots.txt; its `*` Disallow rules are kept. */
  robots: Robots | null;
  /** The merchant's robots.txt as served; when present the fix edits it instead of rewriting it. */
  robotsText?: string;
  sitemapUrl: string | null;
  /** Every URL the sitemap lists (not just the crawled ones). */
  sitemapUrls: string[];
  /** Profile URLs for Organization.sameAs: homepage social links plus any sameAs already in its JSON-LD. */
  sameAs: string[];
  pages: SitePage[];
}

export interface Bundle {
  origin: string;
  platform: Platform;
  generatedAt: string;
  llmsTxt: string;
  robotsTxt: string;
  /** Path (e.g. `/about.md`, `/index.md`) to markdown. */
  markdown: Record<string, string>;
  /** sitemap + schemamap: each crawled page with its .md twin. */
  linkMap: { sitemap: string | null; pages: { url: string; markdown: string; title: string }[]; uncrawled: string[] };
  /** Input for the wp_head fixes (checks 8, 9, 10). */
  entity: { name: string; description: string; sameAs: string[] };
  pages: (PageHead & { path: string; url: string; title: string; description: string })[];
  /** Product pages that show a price; `currency` is '' when the page does not say which. */
  products: { url: string; path: string; name: string; price: string; currency: string; image: string }[];
}

const MAX_PAGES = 20;
const SKIP = /^\/(?:log-?in|sign-?in|sign-?up|register|cart|checkout|account|dashboard|wp-admin)(?:\/|$)/i;

const stripTags = (s: string) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Small HTML to markdown: headings, paragraphs, lists, links, emphasis. Drops chrome and scripts. */
export function htmlToMarkdown(html: string, base: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  let s = body
    .replace(/<(script|style|noscript|template|svg|nav|header|footer|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => {
      const t = stripTags(text);
      try {
        return t ? `[${t}](${new URL(href, base).href})` : '';
      } catch {
        return t;
      }
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n\n${'#'.repeat(Number(n))} ${stripTags(t)}\n\n`)
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, t: string) => `\n- ${t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|ul|ol|table|tr|blockquote)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  s = decode(s);
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Page URL to its markdown twin path: `/` becomes `/index.md`, `/about` becomes `/about.md`. */
export function markdownPath(url: string): string {
  const p = new URL(url).pathname.replace(/\/+$/, '');
  return (p || '/index') + '.md';
}

/** A bot with its own group ignores `*`, so Content-Signal and the merchant's own Disallow rules are repeated in every group. */
const SIGNAL = 'Content-Signal: ai-train=no, search=yes, ai-input=yes';

function renderRobots(site: SiteContent): string {
  const kept = (site.robots?.groups ?? [])
    .filter((g) => g.agents.includes('*'))
    .flatMap((g) => g.rules)
    .filter((r) => !r.allow && r.path !== '/');
  const botGroup = (agent: string) => [`User-agent: ${agent}`, SIGNAL, ...kept.map((r) => `Disallow: ${r.path}`), 'Allow: /', ''];
  const sitemaps = [...new Set([...(site.sitemapUrl ? [site.sitemapUrl] : []), ...(site.robots?.sitemaps ?? [])])];
  if (site.robotsText?.trim()) return mergeRobots(site.robotsText, botGroup, sitemaps);
  const lines: string[] = [];
  for (const agent of ['*', ...SEARCH_BOTS]) lines.push(...botGroup(agent));
  for (const u of sitemaps) lines.push(`Sitemap: ${u}`);
  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Edits the merchant's own robots.txt (including what an SEO plugin wrote): every `*` group gains the Content-Signal,
 * all other groups, Allow lines, comments and Sitemap lines stay as they are. Search bots that are blocked get their
 * restrictive group replaced; bots with no group of their own get one. Only what the checks need is changed.
 */
function mergeRobots(text: string, botGroup: (agent: string) => string[], sitemaps: string[]): string {
  const bots = SEARCH_BOTS.map((b) => b.toLowerCase());
  const blocks: string[][] = [[]];
  let sawRule = true;
  for (const line of text.split(/\r?\n/)) {
    const key = line.replace(/#.*/, '').split(':')[0].trim().toLowerCase();
    if (key === 'user-agent' && sawRule) {
      blocks.push([]);
      sawRule = false;
    } else if (key && key !== 'user-agent' && key !== 'sitemap') sawRule = true;
    blocks[blocks.length - 1].push(line);
  }
  const agentsOf = (b: string[]) => b.filter((l) => /^\s*user-agent\s*:/i.test(l)).map((l) => l.replace(/^[^:]*:/, '').replace(/#.*/, '').trim().toLowerCase());
  const named = new Set<string>();
  const out: string[] = [];
  for (const block of blocks) {
    const agents = agentsOf(block);
    const rules = parseRobots(block.join('\n')).groups[0]?.rules ?? [];
    const blocksAll = rules.some((r) => !r.allow && r.path === '/');
    if (agents.length && agents.every((a) => bots.includes(a)) && blocksAll) continue;
    agents.forEach((a) => named.add(a));
    if (agents.includes('*') && !block.some((l) => /^\s*content-signal\s*:/i.test(l))) {
      const at = block.map((l) => /^\s*user-agent\s*:/i.test(l)).lastIndexOf(true);
      block.splice(at + 1, 0, SIGNAL);
    }
    out.push(...block);
  }
  const body = out.join('\n').trimEnd().split('\n');
  const lines = [...body, ''];
  for (const bot of SEARCH_BOTS) if (!named.has(bot.toLowerCase())) lines.push(...botGroup(bot));
  const have = new Set(body.filter((l) => /^\s*sitemap\s*:/i.test(l)).map((l) => l.replace(/^[^:]*:/, '').trim()));
  for (const u of sitemaps) if (!have.has(u)) lines.push(`Sitemap: ${u}`);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

const homeOf = (site: SiteContent) => site.pages.find((p) => new URL(p.url).pathname === '/');
const siteName = (site: SiteContent) => homeOf(site)?.title.split(/\s[|\-–—]\s/)[0] || new URL(site.origin).hostname;

/** llms.txt is an index of links to the .md twins, never hand-written. */
function renderLlms(site: SiteContent): string {
  const home = homeOf(site);
  const name = siteName(site);
  const lines = [`# ${name}`, ''];
  if (home?.description) lines.push(`> ${home.description}`, '');
  lines.push('## Pages', '');
  for (const p of site.pages) lines.push(`- [${p.title || new URL(p.url).pathname}](${site.origin}${markdownPath(p.url)})${p.description ? `: ${p.description}` : ''}`);
  return lines.join('\n') + '\n';
}

/** Pure: crawled content in, the four artifacts out. */
export function generate(site: SiteContent, now = new Date()): Bundle {
  const markdown: Record<string, string> = {};
  for (const p of site.pages) markdown[markdownPath(p.url)] = (/^#\s/m.test(p.markdown) ? '' : `# ${p.title || p.url}\n\n`) + p.markdown + '\n';
  const crawled = new Set(site.pages.map((p) => p.url));
  return {
    origin: site.origin,
    platform: site.platform,
    generatedAt: now.toISOString(),
    llmsTxt: renderLlms(site),
    robotsTxt: renderRobots(site),
    markdown,
    linkMap: {
      sitemap: site.sitemapUrl,
      pages: site.pages.map((p) => ({ url: p.url, markdown: site.origin + markdownPath(p.url), title: p.title })),
      uncrawled: site.sitemapUrls.filter((u) => !crawled.has(u)),
    },
    entity: { name: siteName(site), description: homeOf(site)?.description ?? '', sameAs: site.sameAs },
    pages: site.pages.map((p) => ({ path: new URL(p.url).pathname, url: p.url, title: p.title, description: p.description, ...p.head })),
    products: site.pages.filter((p) => p.head.product?.price).map((p) => ({ url: p.url, path: new URL(p.url).pathname, name: p.title.split(/\s[|\-–—]\s/)[0] || p.title, price: p.head.product!.price, currency: p.head.product!.currency, image: p.head.image })),
  };
}

const PROFILE_HOST = /^(?:www\.|[a-z]{2}\.)?(?:facebook|instagram|x|twitter|linkedin|youtube|tiktok|pinterest|github|threads)\.com$|(?:^|\.)(?:wikipedia|wikidata)\.org$/i;

/** Social/profile links on the homepage plus sameAs already declared there; share/intent links are not profiles. */
export function profileLinks(html: string, base: string): string[] {
  const declared = jsonLd(html).nodes.flatMap((n) => ([] as unknown[]).concat(n.sameAs ?? [])).filter((x): x is string => typeof x === 'string');
  const linked = anchors(html).flatMap((a) => {
    try {
      const u = new URL(a.href, base);
      return PROFILE_HOST.test(u.hostname) && u.pathname.length > 1 && !/share|intent|dialog/i.test(u.pathname) ? [u.href] : [];
    } catch {
      return [];
    }
  });
  return [...new Set([...declared, ...linked])];
}

function absolute(href: string, base: string): string {
  try {
    return href ? new URL(href, base).href : '';
  } catch {
    return '';
  }
}

export function pageHead(html: string, url: string): PageHead {
  const types = [...new Set(jsonLd(html).nodes.flatMap(typesOf))];
  const isProduct = /\/products?\//i.test(new URL(url).pathname) || meta(html, 'og:type').toLowerCase() === 'product' || types.includes('Product');
  return {
    canonical: linkRel(html, 'canonical').some(Boolean),
    ogTitle: !!meta(html, 'og:title'),
    ogImage: !!meta(html, 'og:image'),
    image: absolute(meta(html, 'og:image') || (tags(html, 'img')[0]?.src ?? ''), url),
    types,
    product: isProduct ? productPrice(html) : null,
  };
}

const SYMBOL_CURRENCY: Record<string, string> = { '€': 'EUR', '£': 'GBP' };

/** Price: product meta, else a JSON-LD Offer, else the first amount in the page text. Currency only when the page states it (an ambiguous `$` is left for the site to supply). */
function productPrice(html: string): { price: string; currency: string } {
  const offer = jsonLd(html).nodes.flatMap((n) => ([] as unknown[]).concat(n.offers ?? [])).find((o): o is Record<string, unknown> => !!o && typeof o === 'object' && 'price' in o);
  let price = meta(html, 'product:price:amount') || meta(html, 'og:price:amount') || (offer ? String(offer.price) : '');
  let currency = meta(html, 'product:price:currency') || meta(html, 'og:price:currency') || (offer && typeof offer.priceCurrency === 'string' ? offer.priceCurrency : '');
  if (!price) {
    const m = /([$€£])\s?(\d[\d,]*(?:\.\d{1,2})?)/.exec(visibleText(html));
    if (m) {
      price = m[2].replace(/,/g, '');
      currency = currency || SYMBOL_CURRENCY[m[1]] || '';
    }
  }
  return { price, currency };
}

/** Same-origin sitemap URLs, plus the child sitemap when the root is an index. */
function sitemapUrls(s: Snapshot): string[] {
  const res = isOk(s.childSitemap) ? s.childSitemap : s.sitemap;
  if (!isOk(res)) return [];
  const p = parseSitemap(res.body);
  return p.isIndex ? [] : p.entries.map((e) => e.loc).filter((u) => {
    try {
      const x = new URL(u);
      return x.origin === s.origin && !SKIP.test(x.pathname);
    } catch {
      return false;
    }
  });
}

/** Fetches the home page and up to `max` sitemap pages through the robots-aware fetcher. */
export async function crawlPages(f: Fetcher, s: Snapshot, max = MAX_PAGES): Promise<{ pages: SitePage[]; sitemapUrls: string[] }> {
  const urls = sitemapUrls(s);
  const queue = [s.origin + '/', ...urls.filter((u) => new URL(u).pathname !== '/')];
  // The home page links to key pages even when there is no sitemap.
  if (isOk(s.home) && urls.length === 0) {
    for (const a of anchors(s.home.body)) {
      try {
        const x = new URL(a.href, s.origin);
        if (x.origin === s.origin && x.pathname !== '/' && !SKIP.test(x.pathname) && !queue.includes(x.origin + x.pathname)) queue.push(x.origin + x.pathname);
      } catch {}
    }
  }
  const pages: SitePage[] = [];
  for (const url of queue) {
    if (pages.length >= max) break;
    const res = url === s.origin + '/' && isOk(s.home) ? s.home : (await f.get(url)).res;
    if (!isOk(res) || !isHtml(res)) continue;
    const markdown = htmlToMarkdown(res.body, url);
    if (!markdown) continue;
    pages.push({ url, title: title(res.body), description: meta(res.body, 'description'), markdown, head: pageHead(res.body, url) });
  }
  return { pages, sitemapUrls: urls };
}

/** `allowPrivate` is for local dev sites only; never set it from user input. */
export async function buildBundle(input: string, opts: FetcherOptions = {}): Promise<Bundle> {
  const full = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const url = opts.allowPrivate ? new URL(full) : assertPublicUrl(full);
  const f = createFetcher(opts);
  const snapshot = await collect(f, url.origin);
  if (!snapshot.home) throw new Error(snapshot.homeError ?? 'homepage not reachable');
  const { pages, sitemapUrls: urls } = await crawlPages(f, snapshot);
  const robots = isOk(snapshot.robots) && !/^\s*</.test(snapshot.robots.body) ? parseRobots(snapshot.robots.body) : null;
  return generate({ origin: url.origin, platform: detectPlatform(snapshot), robots, robotsText: robots ? snapshot.robots!.body : undefined, sitemapUrl: isOk(snapshot.sitemap) && parseSitemap(snapshot.sitemap.body).valid ? snapshot.sitemapUrl : null, sitemapUrls: urls, sameAs: profileLinks(snapshot.home.body, url.origin), pages });
}
