import { anchors, header, isHtml, isOk, jsonLd, linkRel, meta, parseSitemap, title, typesOf, visibleText } from './html.ts';
import { parseRobots, robotsAllows } from './robots.ts';
import type { CheckDef, CheckOutput, Res, Snapshot, Status } from './types.ts';

const out = (status: Status, evidence: string): CheckOutput => ({ status, evidence });
const NA = (why: string) => out('n/a', why);

export const SEARCH_BOTS = ['OAI-SearchBot', 'PerplexityBot', 'ChatGPT-User', 'Claude-SearchBot'];
export const TRAINING_BOTS = ['GPTBot', 'ClaudeBot', 'Google-Extended'];
const DAY = 86_400_000;

function robotsOf(s: Snapshot) {
  return isOk(s.robots) && !isHtml(s.robots) ? parseRobots(s.robots.body) : null;
}

/** URL-level entries; falls back to the index's own entries when `withIndex` and no child was fetched. */
function sitemapEntries(s: Snapshot, withIndex = false) {
  const root = isOk(s.sitemap) ? parseSitemap(s.sitemap.body) : null;
  if (root && !root.isIndex) return root.entries;
  const child = isOk(s.childSitemap) ? parseSitemap(s.childSitemap.body) : null;
  if (child && !child.isIndex) return child.entries;
  return withIndex && root ? root.entries : [];
}

function jsonLdAll(s: Snapshot) {
  const pages = [s.home, s.product].filter((r): r is Res => !!r && isOk(r));
  const parsed = pages.map((p) => jsonLd(p.body));
  return { nodes: parsed.flatMap((p) => p.nodes), invalid: parsed.reduce((n, p) => n + p.invalid, 0) };
}

const ORG_TYPES = ['Organization', 'Corporation', 'LocalBusiness', 'Store', 'OnlineStore', 'OnlineBusiness'];
const isOrg = (n: Record<string, unknown>) => typesOf(n).some((t) => ORG_TYPES.includes(t));

function offerPrice(node: Record<string, unknown>): boolean {
  const offers = ([] as unknown[]).concat(node.offers ?? []);
  return offers.some((o) => {
    const x = o as Record<string, unknown>;
    if (!x || typeof x !== 'object') return false;
    if (x.price != null || x.lowPrice != null) return true;
    return ([] as unknown[]).concat(x.priceSpecification ?? []).some((p) => (p as Record<string, unknown>)?.price != null);
  });
}

const isStore = (s: Snapshot) => !!s.productUrl || s.feeds.some((f) => isOk(f.res) && !isHtml(f.res));

function md(res: Res | null): boolean {
  return isOk(res) && !isHtml(res) && res.body.trim().length > 0;
}

function llmsLinks(body: string): string[] {
  return [...body.matchAll(/\[[^\]]*\]\(\s*([^)\s]+)/g)].map((m) => m[1]);
}

const norm = (u: string, base: string) => {
  try {
    const x = new URL(u, base);
    return x.origin + x.pathname.replace(/\/$/, '');
  } catch {
    return u;
  }
};

// Level 4: optional commerce protocols, one check each.
const found = (s: Snapshot, path: string) => s.protocols.find((p) => p.url.endsWith(path) && isOk(p.res) && !isHtml(p.res));
const paywalled = (s: Snapshot, header: (h: Record<string, string>) => boolean) => s.protocols.find((p) => p.res?.status === 402 && header(p.res.headers));
const payable = (s: Snapshot) => {
  const oa = found(s, '/openapi.json');
  const n = oa?.res?.body.match(/"x-payment-info"/g)?.length ?? 0;
  return oa && n ? `${oa.url} (${n} payable operation${n === 1 ? '' : 's'} with x-payment-info)` : null;
};
const PROTOCOLS: [number, string, string, (s: Snapshot) => string | null][] = [
  [32, 'UCP', '/.well-known/ucp', (s) => found(s, '/.well-known/ucp')?.url ?? null],
  [33, 'ACP', '/.well-known/acp.json', (s) => found(s, '/.well-known/acp.json')?.url ?? null],
  // AP2 is announced as an extension on the A2A agent card
  [34, 'AP2', '/.well-known/agent-card.json', (s) => found(s, '/.well-known/ap2.json')?.url ?? (/ap2/i.test(found(s, '/.well-known/agent-card.json')?.res?.body ?? '') ? found(s, '/.well-known/agent-card.json')!.url : null)],
  // MPP: /openapi.json operations carrying x-payment-info, or a paid resource that answers 402 with `WWW-Authenticate: Payment`
  [35, 'MPP', '/.well-known/mpp', (s) => found(s, '/.well-known/mpp')?.url ?? payable(s) ?? paywalled(s, (h) => /^payment\b/i.test(h['www-authenticate'] ?? ''))?.url ?? null],
  // x402: discovery document, or a 402 carrying a payment-required header
  [36, 'x402', '/.well-known/x402', (s) => found(s, '/.well-known/x402')?.url ?? paywalled(s, (h) => 'payment-required' in h || 'x-payment' in h)?.url ?? null],
];

/** Human-readable pass rule per check, kept next to the code it describes so the public docs cannot drift. */
const PASS_RULES: Record<number, string> = {
  1: '`/robots.txt` answers 200, parses, and contains at least one `User-agent` group.',
  2: 'No named AI search bot (OAI-SearchBot, PerplexityBot, ChatGPT-User, Claude-SearchBot) is disallowed on `/`. All of them blocked is a fail; some of them is partial. Blocking training bots only is a pass.',
  3: 'A `Content-Signal` line in robots.txt with `ai-train`, `ai-input` or `search` set to `yes` or `no`.',
  4: 'A sitemap is found through robots.txt, `/sitemap.xml` or `/wp-sitemap.xml` and is valid XML with URLs. Partial when it is valid but neither referenced in robots.txt nor at `/sitemap.xml`.',
  5: 'At least 90% of sitemap entries have a parseable `lastmod` and the newest is under a year old.',
  6: 'The homepage answers 200 to our crawler. A challenge, 403, 429 or 503 is a fail; any other non-200 is partial.',
  7: 'Title, price and description text are present in the raw HTML of a page, without running JavaScript.',
  8: 'Valid JSON-LD with an Organization or WebSite node, plus a Product node when the page is a product page.',
  9: 'At least two `sameAs` links on the Organization schema (one is partial).',
  10: 'A non-generic title, a meta description of 20+ characters, a canonical link and Open Graph title and image.',
  11: 'No `noindex` in the robots meta tags and no `X-Robots-Tag: noindex` on the homepage.',
  12: 'About, contact, shipping, returns and privacy pages exist and are linked from the homepage.',
  13: 'A price is visible in the HTML or in Offer structured data.',
  14: 'A short plain-language statement of what the site sells and who it is for, on the homepage or about page.',
  15: 'A markdown document answers 200 at `/llms.txt`.',
  16: '`/llms.txt` is markdown, its links resolve, and it fits in one fetch.',
  17: 'The share of sitemap pages listed in llms.txt is above our threshold.',
  18: 'A request with `Accept: text/markdown` gets markdown back, with a `Vary: Accept` header.',
  19: 'A `.md` copy of a page answers at the same path with `.md` appended.',
  20: 'The homepage response carries `Link` headers pointing at useful resources such as the sitemap or llms.txt.',
  21: 'Page content stays under our size threshold for HTML and for markdown.',
  22: 'A URL that does not exist returns 404, not 200.',
  23: 'Redirects stay on the same host, use 301 or 302, and do not chain.',
  24: 'Public product and policy content is reachable without logging in.',
  25: 'Headings are descriptive and content in tabs is present in the HTML.',
  26: 'Images have alt text, form fields have labels, links and buttons have readable names, and clickable elements are real controls.',
  27: 'A product feed is discoverable and returns machine-readable data.',
  28: '`/.well-known/agent-skills/index.json` exists and validates.',
  29: '`/pricing.md` answers 200 with markdown.',
  30: 'The brand entity is linked to the domain through Wikipedia or Wikidata.',
  31: 'The domain shows up for brand and category prompts in live AI search.',
  32: 'A UCP profile is published at `/.well-known/ucp`.',
  33: 'An ACP manifest is published at `/.well-known/acp.json`.',
  34: 'An AP2 document is published at `/.well-known/ap2.json`.',
  35: 'An MPP document is published at `/.well-known/mpp`, or a paid resource answers 402 with `WWW-Authenticate: Payment`.',
  36: 'An x402 document is published at `/.well-known/x402`, or a resource answers 402 with a payment-required header.',
};
const withPassRule = (c: Omit<CheckDef, 'passRule'>): CheckDef => ({ ...c, passRule: PASS_RULES[c.id] ?? '' });

const checks: Omit<CheckDef, 'passRule'>[] = [
  {
    id: 1, name: 'robots.txt exists', level: 1, impact: 'H', weight: 3,
    run: (s) => {
      if (!s.robots) return out('fail', 'robots.txt not reachable');
      if (!isOk(s.robots)) return out('fail', `robots.txt returned ${s.robots.status}`);
      const r = parseRobots(s.robots.body);
      if (isHtml(s.robots) || !r.groups.length) return out('fail', 'robots.txt returned 200 but has no User-agent rules');
      return out('pass', `${r.groups.length} group(s), ${r.sitemaps.length} sitemap line(s)`);
    },
  },
  {
    id: 2, name: 'robots.txt AI crawler policy', level: 1, impact: 'H', weight: 3,
    run: (s) => {
      const r = robotsOf(s);
      if (!r) return out('pass', 'no robots.txt rules, AI bots allowed by default');
      const blocked = (bots: string[]) => bots.filter((b) => !robotsAllows(r, b, '/'));
      const search = blocked(SEARCH_BOTS);
      const training = blocked(TRAINING_BOTS);
      if (search.length === SEARCH_BOTS.length) return out('fail', `all AI search bots blocked: ${search.join(', ')}`);
      if (search.length) return out('partial', `AI search bots blocked: ${search.join(', ')}`);
      return out('pass', training.length ? `search bots allowed; training bots blocked: ${training.join(', ')}` : 'AI bots allowed');
    },
  },
  {
    id: 3, name: 'Content Signals directive', level: 2, impact: 'L', weight: 1,
    run: (s) => {
      const r = robotsOf(s);
      const hit = r?.contentSignals.find((v) => /(ai-train|ai-input|search)\s*=\s*(yes|no)/i.test(v));
      return hit ? out('pass', `Content-Signal: ${hit}`) : out('fail', 'no Content-Signal line in robots.txt');
    },
  },
  {
    id: 4, name: 'sitemap.xml exists', level: 1, impact: 'H', weight: 3,
    run: (s) => {
      if (!isOk(s.sitemap)) return out('fail', s.sitemap ? `${s.sitemapUrl} returned ${s.sitemap.status}` : 'no sitemap found via robots.txt, /sitemap.xml or /wp-sitemap.xml');
      const p = parseSitemap(s.sitemap.body);
      if (!p.valid || !p.entries.length) return out('fail', `${s.sitemapUrl} is not a valid sitemap with URLs`);
      const listed = !!robotsOf(s)?.sitemaps.length;
      const rootPath = new URL(s.sitemapUrl!).pathname === '/sitemap.xml';
      if (!listed && !rootPath) return out('partial', `${s.sitemapUrl} valid but not referenced in robots.txt`);
      return out('pass', `${p.entries.length} ${p.isIndex ? 'child sitemap' : 'URL'}(s) at ${s.sitemapUrl}`);
    },
  },
  {
    id: 5, name: 'Sitemap freshness (lastmod)', level: 2, impact: 'M', weight: 2,
    run: (s) => {
      if (!isOk(s.sitemap)) return NA('no sitemap');
      const entries = sitemapEntries(s, true);
      if (!entries.length) return NA('empty sitemap');
      const dated = entries.filter((e) => e.lastmod && !isNaN(Date.parse(e.lastmod)));
      if (!dated.length) return out('fail', `no lastmod on ${entries.length} entries`);
      const newest = Math.max(...dated.map((e) => Date.parse(e.lastmod!)));
      const ratio = dated.length / entries.length;
      const age = Math.round((Date.now() - newest) / DAY);
      if (ratio >= 0.9 && age <= 365) return out('pass', `${dated.length}/${entries.length} entries have lastmod, newest ${age}d old`);
      return out('partial', `${dated.length}/${entries.length} entries have lastmod, newest ${age}d old`);
    },
  },
  {
    id: 6, name: 'Not blocked by bot protection / WAF', level: 1, impact: 'H', weight: 3,
    run: (s) => {
      const h = s.home;
      if (!h) return NA(s.homeError ?? 'homepage not fetched');
      const mitigated = header(h, 'cf-mitigated') === 'challenge' || /just a moment|attention required|captcha|access denied|verify you are human/i.test(h.body.slice(0, 5000)) && h.status >= 400;
      if (mitigated || [403, 429, 503].includes(h.status)) return out('fail', `homepage returned ${h.status}${mitigated ? ' with challenge page' : ''} to our crawler`);
      if (!isOk(h)) return out('partial', `homepage returned ${h.status}`);
      return out('pass', 'homepage served 200 to our crawler');
    },
  },
  {
    id: 8, name: 'JSON-LD structured data', level: 1, impact: 'H', weight: 3,
    run: (s) => {
      if (!isOk(s.home)) return NA('no homepage');
      const { nodes, invalid } = jsonLdAll(s);
      const types = [...new Set(nodes.flatMap(typesOf))];
      if (!nodes.length) return out('fail', invalid ? `${invalid} JSON-LD block(s) failed to parse` : 'no JSON-LD found');
      const org = nodes.some((n) => isOrg(n) || typesOf(n).includes('WebSite'));
      const product = nodes.some((n) => typesOf(n).some((t) => t === 'Product' || t === 'ProductGroup'));
      const needProduct = !!s.product;
      if (org && (product || !needProduct)) return out('pass', `types: ${types.join(', ')}`);
      return out('partial', `types: ${types.join(', ')}; missing ${org ? 'Product' : 'Organization/WebSite'}`);
    },
  },
  {
    id: 9, name: 'JSON-LD entity linking (sameAs)', level: 2, impact: 'M', weight: 2,
    run: (s) => {
      if (!isOk(s.home)) return NA('no homepage');
      const links = jsonLdAll(s).nodes.filter(isOrg).flatMap((n) => ([] as unknown[]).concat(n.sameAs ?? []).filter((x) => typeof x === 'string'));
      if (links.length >= 2) return out('pass', `${links.length} sameAs links`);
      return links.length ? out('partial', '1 sameAs link') : out('fail', 'no sameAs on Organization schema');
    },
  },
  {
    id: 10, name: 'Metadata completeness', level: 1, impact: 'M', weight: 2,
    run: (s) => {
      if (!isOk(s.home)) return NA('no homepage');
      const html = s.home.body;
      const t = title(html);
      const got = {
        title: t.length > 0 && !/^(home|untitled|just another wordpress site)$/i.test(t),
        description: meta(html, 'description').length >= 20,
        canonical: linkRel(html, 'canonical').length > 0,
        og: !!meta(html, 'og:title') && !!meta(html, 'og:image'),
      };
      const missing = Object.entries(got).filter(([, v]) => !v).map(([k]) => k);
      if (!missing.length) return out('pass', 'title, description, canonical, og tags present');
      return out(missing.length <= 2 ? 'partial' : 'fail', `missing: ${missing.join(', ')}`);
    },
  },
  {
    id: 11, name: 'Homepage not hidden (noindex)', level: 1, impact: 'H', weight: 3,
    run: (s) => {
      if (!s.home) return NA('no homepage');
      const tag = ['robots', 'googlebot', 'bingbot'].map((n) => meta(s.home!.body, n)).find((v) => /noindex|none/i.test(v));
      const hdr = header(s.home, 'x-robots-tag');
      if (tag) return out('fail', `meta robots: ${tag}`);
      if (/noindex|none/i.test(hdr)) return out('fail', `X-Robots-Tag: ${hdr}`);
      return out('pass', 'no noindex directive');
    },
  },
  {
    id: 12, name: 'Trust anchor pages', level: 1, impact: 'M', weight: 2,
    run: (s) => {
      if (!isOk(s.home)) return NA('no homepage');
      const kinds: Record<string, RegExp> = {
        about: /about/i, contact: /contact/i, shipping: /shipping|delivery/i, returns: /return|refund/i, privacy: /privacy/i, terms: /terms|conditions/i,
      };
      const links = anchors(s.home.body);
      const found = Object.keys(kinds).filter((k) => links.some((a) => kinds[k].test(a.href) || kinds[k].test(a.text)));
      const missing = Object.keys(kinds).filter((k) => !found.includes(k));
      if (found.length >= 4) return out('pass', `linked: ${found.join(', ')}`);
      return out(found.length >= 2 ? 'partial' : 'fail', `linked: ${found.join(', ') || 'none'}; missing: ${missing.join(', ')}`);
    },
  },
  {
    id: 13, name: 'Pricing info accessible', level: 1, impact: 'H', weight: 3,
    run: (s) => {
      const pages = [s.home, s.product].filter(isOk);
      if (!pages.length) return NA('no pages fetched');
      if (jsonLdAll(s).nodes.some(offerPrice)) return out('pass', 'Offer price in JSON-LD');
      const html = pages.map((p) => p.body).join('\n');
      if (/itemprop=["']price["']|product:price:amount|og:price:amount|[$€£]\s?\d[\d,.]*/i.test(html)) return out('partial', 'price visible in HTML but not in Offer schema');
      return isStore(s) ? out('fail', 'no price found in HTML or structured data') : NA('no product pages detected');
    },
  },
  {
    id: 14, name: 'Agent instruction / what-we-do text', level: 2, impact: 'M', weight: 2,
    run: (s) => {
      if (!isOk(s.home)) return NA('no homepage');
      const text = visibleText(s.home.body).length;
      const desc = meta(s.home.body, 'description').length;
      if (text >= 300 && desc >= 50) return out('pass', `${text} chars of homepage text, ${desc}-char description (heuristic)`);
      if (text >= 150 || desc >= 50) return out('partial', `${text} chars of homepage text, ${desc}-char description (heuristic)`);
      return out('fail', `only ${text} chars of readable homepage text`);
    },
  },
  {
    id: 15, name: 'llms.txt exists', level: 1, impact: 'M', weight: 2,
    run: (s) => {
      if (!isOk(s.llms)) return out('fail', s.llms ? `/llms.txt returned ${s.llms.status}` : '/llms.txt not reachable');
      if (isHtml(s.llms) || !s.llms.body.trim()) return out('fail', '/llms.txt returned 200 but not a text file');
      return out('pass', `/llms.txt ${s.llms.body.length} bytes`);
    },
  },
  {
    id: 16, name: 'llms.txt valid, links resolve', level: 2, impact: 'L', weight: 1,
    run: (s) => {
      if (!isOk(s.llms) || isHtml(s.llms)) return NA('no llms.txt');
      const body = s.llms.body;
      const h1 = /^#\s+\S/m.test(body);
      const links = llmsLinks(body);
      const broken = s.llmsLinks.filter((l) => !isOk(l.res));
      const resolved = s.llmsLinks.length ? 1 - broken.length / s.llmsLinks.length : 1;
      // AFDocs thresholds: >=90% of links resolve; size pass <=50k chars, fail >100k.
      const size = body.length;
      if (h1 && links.length && resolved > 0.9 && size <= 50_000 && !broken.length) return out('pass', `H1 present, ${links.length} links, ${s.llmsLinks.length} sampled ok, ${size} chars`);
      const issues = [!h1 && 'no H1', !links.length && 'no links', broken.length && `${broken.length}/${s.llmsLinks.length} sampled links broken e.g. ${broken[0].url}`, size > 50_000 && `${size} chars (AFDocs: >50k warn, >100k fail)`].filter(Boolean);
      return out(h1 || links.length ? 'partial' : 'fail', issues.join('; '));
    },
  },
  {
    id: 17, name: 'llms.txt coverage of sitemap', level: 2, impact: 'L', weight: 1,
    run: (s) => {
      if (!isOk(s.llms) || isHtml(s.llms)) return NA('no llms.txt');
      const all = sitemapEntries(s).map((e) => norm(e.loc, s.origin));
      // key pages only: skip translations (/de/x when /x is also in the sitemap) and login/checkout-style pages
      const known = new Set(all.map((u) => u.slice(s.origin.length) || '/'));
      const locs = all.filter((u) => {
        const path = u.slice(s.origin.length) || '/';
        const stripped = path.replace(/^\/[a-z]{2}(?:-[A-Za-z]{2,4})?(?=\/|$)/, '') || '/';
        const translation = stripped !== path && known.has(stripped);
        return !translation && !/^\/(?:log-?in|sign-?in|sign-?up|register|cart|checkout|account|dashboard)(?:\/|$)/i.test(path);
      });
      if (!locs.length) return NA('no URL-level sitemap fetched');
      // llms.txt usually links the .md twin of a page (/docs/api.md for /docs/api); count it as listing the page.
      const unMd = (u: string) => norm(u, s.origin).replace(/\/index\.md$/, '').replace(/\.md$/, '');
      const listed = new Set(llmsLinks(s.llms.body).map(unMd));
      const hit = locs.filter((l) => listed.has(l)).length;
      const ratio = hit / locs.length;
      const ev = `${hit}/${locs.length} key sitemap URLs listed (${Math.round(ratio * 100)}%, ${all.length - locs.length} translations/login pages skipped); AFDocs pass >=95%, warn >=80%`;
      return ratio >= 0.95 ? out('pass', ev) : ratio >= 0.8 ? out('partial', ev) : out('fail', ev);
    },
  },
  {
    id: 18, name: 'Markdown for agents (Accept: text/markdown)', level: 2, impact: 'M', weight: 2,
    run: (s) => {
      if (!s.markdownAccept) return NA('request failed');
      const ct = header(s.markdownAccept, 'content-type');
      if (isOk(s.markdownAccept) && /text\/markdown/i.test(ct)) return out('pass', `Content-Type ${ct}${/accept/i.test(header(s.markdownAccept, 'vary')) ? '' : ' (no Vary: Accept)'}`);
      return out('fail', `got ${s.markdownAccept.status} ${ct || 'no content-type'} for Accept: text/markdown`);
    },
  },
  {
    id: 19, name: '.md URL variants', level: 3, impact: 'L', weight: 1,
    run: (s) => {
      const probes = [s.indexMd, s.productUrl ? s.productMd : undefined].filter((p): p is Res | null => p !== undefined);
      const ok = probes.filter(md).length;
      if (ok === probes.length && ok) return out('pass', `${ok}/${probes.length} .md probes returned markdown`);
      return out(ok ? 'partial' : 'fail', `${ok}/${probes.length} .md probes returned markdown`);
    },
  },
  {
    id: 20, name: 'HTTP Link headers (RFC 8288)', level: 2, impact: 'L', weight: 1,
    run: (s) => {
      if (!s.home) return NA('no homepage');
      const link = header(s.home, 'link');
      const rels = [...link.matchAll(/rel="?([^";,]+)/gi)].flatMap((m) => m[1].toLowerCase().split(/\s+/));
      const useful = rels.filter((r) => ['sitemap', 'describedby', 'service-doc', 'service-desc', 'api-catalog', 'alternate'].includes(r));
      if (useful.length) return out('pass', `Link rels: ${useful.join(', ')}`);
      return out('fail', rels.length ? `Link header has only: ${[...new Set(rels)].join(', ')}` : 'no Link header');
    },
  },
  {
    id: 22, name: 'Real 404 status codes', level: 2, impact: 'M', weight: 2,
    run: (s) => {
      if (!s.notFound) return NA('request failed');
      if ([404, 410].includes(s.notFound.status)) return out('pass', `missing URL returned ${s.notFound.status}`);
      if (isOk(s.notFound)) return out('fail', `missing URL returned ${s.notFound.status}${s.notFound.redirects ? ' after redirect' : ''} (soft 404)`);
      return out('partial', `missing URL returned ${s.notFound.status}`);
    },
  },
  {
    id: 26, name: 'Accessibility: native controls, names, labels', level: 3, impact: 'M', weight: 2,
    run: (s) => {
      if (!isOk(s.home)) return NA('no homepage');
      const html = s.home.body.replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, '');
      let total = 0;
      let bad = 0;
      const notes: string[] = [];
      const count = (label: string, n: number, b: number) => {
        total += n;
        bad += b;
        if (b) notes.push(`${b}/${n} ${label}`);
      };
      const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
      count('img without alt', imgs.length, imgs.filter((t) => !/\balt\s*=/i.test(t)).length);
      const inputs = [...html.matchAll(/<(input|select|textarea)\b[^>]*>/gi)].map((m) => m[0]).filter((t) => !/type=["']?(hidden|submit|button|image)/i.test(t));
      const labelFor = new Set([...html.matchAll(/<label\b[^>]*\bfor=["']([^"']+)/gi)].map((m) => m[1]));
      count('unlabeled form fields', inputs.length, inputs.filter((t) => !/aria-label(ledby)?=|\btitle=/i.test(t) && !labelFor.has(/\bid=["']([^"']+)/i.exec(t)?.[1] ?? '\0')).length);
      const named = [...html.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi)];
      count('links/buttons without name', named.length, named.filter((m) => !/aria-label=|\btitle=/i.test(m[2]) && !m[3].replace(/<img\b[^>]*\balt=["'][^"']+["'][^>]*>/gi, 'x').replace(/<[^>]+>/g, '').trim()).length);
      const fakes = [...html.matchAll(/<(div|span)\b[^>]*\bonclick=[^>]*>/gi)].filter((m) => !/role=/i.test(m[0]));
      count('clickable div/span without role', fakes.length, fakes.length);
      if (!total) return NA('no interactive elements');
      const ratio = bad / total;
      const ev = `${bad}/${total} elements with issues${notes.length ? ': ' + notes.join('; ') : ''} (regex heuristic)`;
      return ratio < 0.1 ? out('pass', ev) : ratio < 0.3 ? out('partial', ev) : out('fail', ev);
    },
  },
  {
    id: 27, name: 'Product feed / commerce data', level: 3, impact: 'M', weight: 2,
    run: (s) => {
      const hit = s.feeds.find((f) => isOk(f.res) && !isHtml(f.res));
      if (hit) return out('pass', `feed at ${hit.url}`);
      return isStore(s) ? out('fail', 'store detected but no product feed found') : NA('no store detected');
    },
  },
  {
    id: 29, name: 'pricing.md', level: 3, impact: 'L', weight: 1,
    run: (s) => (md(s.pricingMd) ? out('pass', '/pricing.md serves markdown') : out('fail', s.pricingMd ? `/pricing.md returned ${s.pricingMd.status}` : '/pricing.md not reachable')),
  },
  ...PROTOCOLS.map(([id, name, path, detect]): Omit<CheckDef, 'passRule'> => ({
    id, name, level: 4, impact: 'L', weight: 1,
    run: (s) => {
      const hit = detect(s);
      return hit ? out('pass', `${name} detected at ${hit}`) : out('fail', `${name} not detected (checked ${path})`);
    },
  })),
];

export const CHECKS: readonly CheckDef[] = checks.map(withPassRule);
