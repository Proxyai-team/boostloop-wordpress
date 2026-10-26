import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBundle, generate, htmlToMarkdown, markdownPath, pageHead, profileLinks } from './generate.ts';
import { decode, title } from './html.ts';
import { parseRobots, robotsAllows } from './robots.ts';
import { scan } from './scan.ts';
import { badShop, fakeFetch, goodShop, robotsBlocked, type Site } from './fixtures/sites.ts';
import type { CheckResult } from './types.ts';

const opts = (site: Site) => ({ fetchImpl: fakeFetch(site), gapMs: 0 });
const byId = (checks: CheckResult[]) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

// good.test minus llms.txt and markdown; its robots.txt has no Content-Signal, so the bundle must add it
const bare: Site = {
  '/': goodShop['/'],
  '/products/ethiopia': goodShop['/products/ethiopia'],
  '/about': { body: '<html><head><title>About Acme</title><meta name="description" content="Who we are."></head><body><h1>About</h1><p>We roast <strong>coffee</strong>.</p></body></html>' },
  '/sitemap.xml': goodShop['/sitemap.xml'],
  '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /cart\nSitemap: https://good.test/sitemap.xml\n' },
};

test('htmlToMarkdown keeps structure, drops chrome and scripts', () => {
  const md = htmlToMarkdown('<html><body><nav>menu</nav><script>x()</script><h1>Hi</h1><p>A <a href="/x">link</a> and <em>em</em>.</p><ul><li>one</li><li>two</li></ul><footer>f</footer></body></html>', 'https://a.test/');
  assert.equal(md, '# Hi\n\nA [link](https://a.test/x) and *em*.\n\n- one\n- two');
});

test('markdownPath maps pages to .md twins', () => {
  assert.equal(markdownPath('https://a.test/'), '/index.md');
  assert.equal(markdownPath('https://a.test/about/'), '/about.md');
  assert.equal(markdownPath('https://a.test/products/x'), '/products/x.md');
});

test('bundle has all four artifacts, non-empty', async () => {
  const b = await buildBundle('https://good.test', opts(bare));
  assert.match(b.llmsTxt, /^# Acme/);
  assert.match(b.llmsTxt, /\(https:\/\/good\.test\/about\.md\)/);
  assert.ok(Object.keys(b.markdown).length >= 3);
  for (const [path, md] of Object.entries(b.markdown)) assert.ok(md.trim().length > 0 && path.endsWith('.md'), path);
  assert.ok(b.markdown['/about.md'].includes('**coffee**'));
  assert.ok(b.linkMap.pages.length >= 3);
  assert.equal(b.linkMap.sitemap, 'https://good.test/sitemap.xml');
});

test('htmlToMarkdown keeps emphasis inside list items', () => {
  assert.equal(htmlToMarkdown('<ul><li>bold <strong>x</strong> here</li></ul>', 'https://a.test/'), '- bold **x** here');
});

test('robots.txt: Content-Signal, search bots allowed, merchant rules and sitemap kept', async () => {
  const b = await buildBundle('https://good.test', opts(bare));
  const r = parseRobots(b.robotsTxt);
  assert.ok(r.contentSignals.some((v) => /ai-train=no/.test(v)));
  // a bot with its own group ignores `*`, so every group must carry the signal
  assert.equal(b.robotsTxt.split('\n').filter((l) => l.startsWith('Content-Signal:')).length, 5);
  for (const bot of ['OAI-SearchBot', 'PerplexityBot', 'ChatGPT-User', 'Claude-SearchBot']) assert.ok(robotsAllows(r, bot, '/'), bot);
  for (const bot of ['SomeBot', 'PerplexityBot', 'OAI-SearchBot']) assert.equal(robotsAllows(r, bot, '/cart'), false, `${bot} /cart`);
  assert.deepEqual(r.sitemaps, ['https://good.test/sitemap.xml']);
});

test('robots.txt: an SEO plugin\'s own groups, Allow lines and comments survive; a blocked search bot is freed', async () => {
  const yoast = '# Yoast\nUser-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n\nUser-agent: AhrefsBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /\n\nSitemap: https://good.test/sitemap_index.xml\n';
  const site: Site = { ...bare, '/robots.txt': { type: 'text/plain', body: yoast } };
  const b = await buildBundle('https://good.test', opts(site));
  const r = parseRobots(b.robotsTxt);
  assert.ok(b.robotsTxt.includes('# Yoast') && b.robotsTxt.includes('Allow: /wp-admin/admin-ajax.php'));
  assert.equal(robotsAllows(r, 'AhrefsBot', '/'), false, 'unrelated bot stays blocked');
  assert.equal(robotsAllows(r, 'PerplexityBot', '/'), true, 'blocked search bot freed');
  assert.equal(robotsAllows(r, 'OAI-SearchBot', '/'), true);
  assert.equal(robotsAllows(r, 'SomeBot', '/wp-admin/'), false);
  assert.ok(r.contentSignals.length >= 5);
  assert.ok(r.sitemaps.includes('https://good.test/sitemap_index.xml') && r.sitemaps.includes('https://good.test/sitemap.xml'));
  assert.equal(b.robotsTxt.split('\n').filter((l) => /^user-agent:\s*\*/i.test(l)).length, 1);
});

test('link map covers every sitemap page: crawled or listed as uncrawled', async () => {
  const b = await buildBundle('https://good.test', opts(bare));
  const mapped = new Set([...b.linkMap.pages.map((p) => p.url), ...b.linkMap.uncrawled]);
  for (const u of ['https://good.test/products/ethiopia', 'https://good.test/about']) assert.ok(mapped.has(u), u);
});

test('round trip: serving the bundle makes the llms.txt/robots/markdown checks pass', async () => {
  const b = await buildBundle('https://good.test', opts(bare));
  const served: Site = { ...bare, '/robots.txt': { type: 'text/plain', body: b.robotsTxt }, '/llms.txt': { type: 'text/plain', body: b.llmsTxt } };
  for (const [path, md] of Object.entries(b.markdown)) served[path] = { type: 'text/markdown', body: md };
  served['/@md'] = { type: 'text/markdown', body: b.markdown['/index.md'] };
  const s = byId((await scan('https://good.test', opts(served))).checks);
  const before = byId((await scan('https://good.test', opts(bare))).checks);
  for (const id of [2, 3, 15, 16, 17, 18, 19]) assert.equal(s[id], 'pass', `check ${id}`);
  for (const id of [3, 15, 18, 19]) assert.equal(before[id], 'fail', `check ${id} before`);
});

test('llms.txt fail path: page that is not in the bundle is not listed', () => {
  const b = generate({ origin: 'https://a.test', platform: 'website', robots: null, sitemapUrl: null, sitemapUrls: ['https://a.test/x'], sameAs: [], pages: [{ url: 'https://a.test/', title: 'A', description: '', markdown: 'hi', head: pageHead('', 'https://a.test/') }] });
  assert.ok(!b.llmsTxt.includes('/x'));
  assert.deepEqual(b.linkMap.uncrawled, ['https://a.test/x']);
});

test('profileLinks: social profiles and declared sameAs, never share links', () => {
  const html = '<script type="application/ld+json">{"@type":"Organization","sameAs":["https://www.wikidata.org/wiki/Q1"]}</script>'
    + '<a href="https://www.instagram.com/acme">ig</a><a href="https://twitter.com/intent/tweet?u=x">share</a><a href="https://facebook.com/sharer.php">s</a><a href="https://facebook.com/">root</a><a href="/about">a</a>';
  assert.deepEqual(profileLinks(html, 'https://a.test/'), ['https://www.wikidata.org/wiki/Q1', 'https://www.instagram.com/acme']);
});

test('decode handles numeric entities, so WordPress titles split into a clean site name', () => {
  assert.equal(decode('coffeedrinker &#8211; Specialty &#x2014; &amp;#38; ok'), 'coffeedrinker – Specialty — &#38; ok');
  const b = generate({ origin: 'https://a.test', platform: 'wordpress', robots: null, sitemapUrl: null, sitemapUrls: [], sameAs: [], pages: [{ url: 'https://a.test/', title: title('<title>coffeedrinker &#8211; Specialty coffee</title>'), description: '', markdown: 'hi', head: pageHead('', 'https://a.test/') }] });
  assert.equal(b.entity.name, 'coffeedrinker');
});

test('pageHead: existing tags, JSON-LD types, product price', () => {
  const h = pageHead('<link rel="canonical" href="/x"><meta property="og:type" content="product"><meta property="product:price:amount" content="9.50"><meta property="product:price:currency" content="EUR"><img src="/a.jpg">', 'https://a.test/shop/x');
  assert.deepEqual(h, { canonical: true, ogTitle: false, ogImage: false, image: 'https://a.test/a.jpg', types: [], product: { price: '9.50', currency: 'EUR' } });
  assert.equal(pageHead('<p>hi</p>', 'https://a.test/about').product, null);
});

test('unreachable or robots-blocked site throws instead of storing an empty bundle', async () => {
  await assert.rejects(buildBundle('https://bad.test', opts({ '*': { status: 500 } })));
  await assert.rejects(buildBundle('https://blocked.test', opts(robotsBlocked)), /robots/);
  await assert.rejects(buildBundle('http://localhost', opts(badShop)), /not public/);
});
