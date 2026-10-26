import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPublicUrl, createFetcher } from './fetcher.ts';
import { parseRobots, robotsAllows } from './robots.ts';
import { collect, detectPlatform, evaluate, scan, siteLogo } from './scan.ts';
import { score } from './score.ts';
import { badShop, fakeFetch, goodShop, robotsBlocked, wafSite, type Site } from './fixtures/sites.ts';
import type { CheckResult } from './types.ts';

const opts = (site: Site, log?: string[]) => ({ fetchImpl: fakeFetch(site, log), gapMs: 0 });
const run = async (site: Site) => scan('https://good.test', opts(site));
const byId = (r: { checks: CheckResult[] }) => Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
// keyed by host + path, so each origin can serve its own robots.txt and redirects
const routed = (routes: Record<string, { status?: number; location?: string; body?: string }>, seen: string[] = []) =>
  (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    seen.push(u.href);
    const r = routes[u.host + u.pathname] ?? { status: 404 };
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.location ? { location: r.location } : {} });
  }) as typeof fetch;

// every v1 row: pass path on goodShop, fail path on badShop
const V1 = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 26, 27, 29, 32, 33, 34, 35, 36];
// good fixture serves markdown for Accept via separate '/@md' key
const goodWithMd: Site = { ...goodShop, '/@md': { type: 'text/markdown', body: '# Acme' } };

test('good shop passes every check (optional commerce checks pass too)', async () => {
  const r = await run(goodWithMd);
  const s = byId(r);
  for (const id of V1) assert.equal(s[id], 'pass', `check ${id}: ${r.checks.find((c) => c.id === id)!.evidence}`);
  assert.equal(r.checks.length, V1.length);
  assert.deepEqual(r.score.blockers, []);
  assert.ok(r.score.overall > 95);
  assert.equal(r.refund.eligible, false);
});

test('bad shop: each check fails or is n/a, blockers cost 5 each', async () => {
  const r = await run(badShop);
  const s = byId(r);
  assert.equal(s[1], 'pass');
  for (const id of [2, 3, 4, 8, 10, 11, 12, 15, 18, 19, 20, 22, 29, 32, 33, 34, 35, 36]) assert.equal(s[id], 'fail', `check ${id}: ${r.checks.find((c) => c.id === id)!.evidence}`);
  for (const id of [5, 9, 16, 17]) assert.ok(['n/a', 'fail'].includes(s[id]), `check ${id}`);
  assert.equal(s[26], 'fail');
  assert.equal(s[27], 'n/a');
  assert.ok(r.score.blockers.length >= 2);
  assert.equal(r.score.overall, Math.max(0, r.score.raw - 5 * r.score.blockers.length));
});

test('partial paths', async () => {
  const mutate = async (patch: Site) => byId(await run({ ...goodWithMd, ...patch }));
  assert.equal((await mutate({ '/robots.txt': { type: 'text/plain', body: 'User-agent: ChatGPT-User\nDisallow: /\nSitemap: https://good.test/sitemap.xml' } }))[2], 'partial');
  assert.equal((await mutate({ '/robots.txt': { type: 'text/plain', body: 'User-agent: GPTBot\nDisallow: /\n' } }))[2], 'pass');
  assert.equal((await mutate({ '/sitemap.xml': { body: '<urlset><url><loc>https://good.test/about</loc></url></urlset>' } }))[5], 'fail');
  assert.equal((await mutate({ '/': { body: '<html><head><title>Shop</title></head><body>$5.00</body></html>' } }))[10], 'fail');
  assert.equal((await mutate({ '/llms.txt': { type: 'text/plain', body: '# Acme\n- [Gone](/gone)\n' } }))[16], 'partial');
  assert.equal((await mutate({ '/index.md': { status: 404 } }))[19], 'partial');
  assert.equal((await mutate({ '/products/ethiopia': { body: '<html><body>$18.00</body></html>' } }))[13], 'partial');
  assert.equal((await mutate({ '/@md': { status: 404 } }))[18], 'fail');
});

test('noindex via header, WAF wall', async () => {
  const hdr = byId(await run({ ...goodWithMd, '/': { ...goodShop['/'], headers: { 'x-robots-tag': 'noindex' } } }));
  assert.equal(hdr[11], 'fail');
  const waf = await run(wafSite);
  assert.equal(waf.refund.reason, 'waf_blocked');
  assert.equal(byId(waf)[6], 'fail');
  assert.ok(waf.score.blockers.includes('bot protection / WAF blocks crawler'));
});

test('refund signal: robots-blocked and unreachable', async () => {
  const rb = await run(robotsBlocked);
  assert.equal(rb.refund.reason, 'blocked_by_robots');
  const down = await scan('https://good.test', { gapMs: 0, fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch });
  assert.equal(down.refund.reason, 'unreachable');
  assert.equal(down.score.overall >= 0, true);
});

test('scoring: 0.3 weights over 4 levels, no gate, blockers cost 5, no cap, floor 0', () => {
  const c = (id: number, level: 1 | 2 | 3 | 4, weight: number, status: CheckResult['status']): CheckResult => ({ id, name: '', level, weight, status, evidence: '' });
  // L1: 3 pass + 0 fail + 1 partial of 8 weight = 50; L2/L3 still count
  const s = score([c(1, 1, 3, 'pass'), c(4, 1, 3, 'fail'), c(10, 1, 2, 'partial'), c(14, 2, 2, 'pass'), c(19, 3, 1, 'pass')]);
  assert.equal(Math.round(s.levels[1].score! * 100) / 100, 50);
  assert.equal(s.raw, 0.3 * 50 + 0.3 * 100 + 0.3 * 100);
  const open = score([c(1, 1, 3, 'pass'), c(14, 2, 2, 'pass'), c(19, 3, 1, 'partial')]);
  assert.equal(open.raw, 0.3 * 100 + 0.3 * 100 + 0.3 * 50);
  // one blocker costs 5 and is not capped (overall > 100)
  const blocked = score([c(1, 1, 10, 'pass'), c(2, 1, 1, 'fail'), c(14, 2, 2, 'pass'), c(19, 3, 1, 'pass'), c(32, 4, 1, 'pass')]);
  assert.deepEqual(blocked.blockers, ['AI search bots blocked in robots.txt']);
  assert.ok(Math.abs(blocked.overall - (blocked.raw - 5)) < 1e-9);
  assert.ok(blocked.overall > 100);
  // blockers can drive overall below zero, which floors at 0
  assert.equal(score([c(1, 1, 3, 'fail'), c(2, 1, 1, 'fail'), c(6, 1, 1, 'fail'), c(11, 1, 1, 'fail')]).overall, 0);
  // empty level is excluded: adds 0, not 100
  const empty = score([c(1, 1, 3, 'pass'), c(14, 2, 2, 'pass')]);
  assert.equal(empty.levels[3].score, null);
  assert.equal(empty.raw, 0.3 * 100 + 0.3 * 100);
  assert.equal(score([c(32, 4, 1, 'fail'), c(1, 1, 3, 'n/a')]).levels[3].checks, 0);
  // L4 is scored like the others
  const l4 = score([c(1, 1, 3, 'pass'), c(32, 4, 1, 'pass'), c(33, 4, 1, 'fail')]);
  assert.equal(l4.levels[4].score, 50);
  assert.equal(l4.raw, 0.3 * 100 + 0.3 * 50);
});

test('robots.txt: redirects followed, 5xx disallows all, 404 allows', async () => {
  // apex -> www hop: rules from the redirect target must still apply to the apex origin
  const seen: string[] = [];
  const apex = createFetcher({
    gapMs: 0,
    fetchImpl: routed({ 'a.test/robots.txt': { status: 301, location: 'https://www.a.test/robots.txt' }, 'www.a.test/robots.txt': { body: 'User-agent: *\nDisallow: /secret\n' } }, seen),
  });
  assert.match((await apex.get('https://a.test/secret')).error ?? '', /robots/);
  assert.ok(!seen.some((u) => u.endsWith('/secret')), 'blocked page never requested');

  const down = createFetcher({ gapMs: 0, fetchImpl: routed({ 'b.test/robots.txt': { status: 503 } }) });
  assert.match((await down.get('https://b.test/')).error ?? '', /robots/);

  const none = createFetcher({ gapMs: 0, fetchImpl: routed({}) });
  assert.equal((await none.get('https://c.test/')).error, undefined);

  // network error or timeout on robots.txt: RFC 9309 says disallow all
  const timeout = createFetcher({ gapMs: 0, fetchImpl: (async () => { throw new Error('ETIMEDOUT'); }) as typeof fetch });
  assert.match((await timeout.get('https://e.test/')).error ?? '', /robots/);
});

test('redirect into private space is refused', async () => {
  const f = createFetcher({ gapMs: 0, fetchImpl: routed({ 'a.test/robots.txt': { status: 404 }, 'a.test/page': { status: 302, location: 'http://[::1]/' } }) });
  assert.match((await f.get('https://a.test/page')).error ?? '', /bad redirect target/);
});

test('assertPublicUrl: private IPv4/IPv6 ranges rejected, public allowed', () => {
  for (const u of ['http://[::1]/', 'http://[::]/', 'http://[::ffff:127.0.0.1]/', 'http://[::127.0.0.1]/', 'http://[::ffff:100.64.0.1]/', 'http://[fd12:3456::1]/', 'http://[fe80::1]/', 'http://[2002:7f00:1::]/', 'http://100.64.0.1/', 'http://10.1.2.3/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://192.0.0.1/', 'http://198.18.0.1/', 'http://224.0.0.1/', 'http://240.0.0.1/', 'http://169.254.169.254/', 'http://0.0.0.0/']) {
    assert.throws(() => assertPublicUrl(u), /public/, u);
  }
  for (const u of ['https://[2606:4700::1111]/', 'https://[2002:808:808::]/', 'https://[::ffff:8.8.8.8]/', 'https://1.1.1.1/', 'https://100.128.0.1/', 'https://172.32.0.1/', 'https://198.20.0.1/']) {
    assert.doesNotThrow(() => assertPublicUrl(u), u);
  }
});

test('robots parser: longest match, wildcard, group selection', () => {
  const r = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.pdf$\nUser-agent: GPTBot\nDisallow: /\n');
  assert.equal(robotsAllows(r, 'Foo', '/private/x'), false);
  assert.equal(robotsAllows(r, 'Foo', '/private/ok'), true);
  assert.equal(robotsAllows(r, 'Foo', '/a.pdf'), false);
  assert.equal(robotsAllows(r, 'Foo', '/a.pdf?x'), true);
  assert.equal(robotsAllows(r, 'GPTBot', '/anything'), false);
});

test('fetcher: redirect limit, same-run robots, rate limit', async () => {
  const loop = createFetcher({ gapMs: 0, maxRedirects: 3, fetchImpl: (async (u: string | URL | Request) => new Response('', { status: 302, headers: { location: new URL(String(u)).origin + '/next' } })) as typeof fetch });
  const r = await loop.get('https://x.test/robots.txt', { respectRobots: false });
  assert.equal(r.error, 'too many redirects');
  assert.equal(r.res?.redirects, 3);

  const sleeps: number[] = [];
  const f = createFetcher({ gapMs: 1000, fetchImpl: fakeFetch(goodShop), sleep: async (ms) => void sleeps.push(ms) });
  await f.get('https://good.test/about');
  await f.get('https://good.test/about');
  assert.ok(sleeps.length >= 2 && sleeps.every((ms) => ms > 0 && ms <= 1000), 'waits between same-host requests');

  const log: string[] = [];
  const blocked = createFetcher({ gapMs: 0, fetchImpl: fakeFetch({ '/robots.txt': { body: 'User-agent: BoostloopAEO\nDisallow: /secret\n' }, '*': {} }, log) });
  assert.match((await blocked.get('https://a.test/secret')).error ?? '', /robots/);
  assert.ok(!log.includes('/secret'));
});

test('private hosts rejected', async () => {
  await assert.rejects(scan('http://127.0.0.1/'), /public/);
  await assert.rejects(scan('ftp://example.com'), /public|http/);
});

test('collect + evaluate reuse snapshot', async () => {
  const snap = await collect(createFetcher(opts(goodWithMd)), 'https://good.test');
  assert.equal(evaluate(snap).length, V1.length);
});

test('platform detected from homepage markers', async () => {
  const snap = await collect(createFetcher(opts(goodWithMd)), 'https://good.test');
  const home = (body: string, headers: Record<string, string> = {}) => ({ ...snap, home: { ...snap.home!, body, headers } });
  assert.equal(detectPlatform(home('<script src="https://cdn.shopify.com/s/x.js">')), 'shopify');
  assert.equal(detectPlatform(home('<link href="/wp-content/themes/a.css">')), 'wordpress');
  assert.equal(detectPlatform(home('<html>plain</html>')), 'website');
  assert.equal(detectPlatform({ ...snap, home: null }), 'website');
});

const page = (body: string) => ({ url: 'https://good.test/', status: 200, headers: { 'content-type': 'text/html' }, body, redirects: 0 });

test('siteLogo: Organization logo first, then icon links, else empty (default mark)', () => {
  const ld = '<script type="application/ld+json">{"@graph":[{"@type":"Organization","logo":{"url":"/img/logo.png"}}]}</script>';
  assert.equal(siteLogo(page(`<link rel="icon" href="/f.ico">${ld}`), 'https://good.test'), 'https://good.test/img/logo.png');
  assert.equal(siteLogo(page('<link rel="shortcut icon" href="/f.ico">'), 'https://good.test'), 'https://good.test/f.ico');
  assert.equal(siteLogo(page('<link rel="apple-touch-icon" href="/a.png"><link rel="icon" href="/f.ico">'), 'https://good.test'), 'https://good.test/a.png');
  assert.equal(siteLogo(page('<link rel="icon" href="javascript:alert(1)">'), 'https://good.test'), '');
  assert.equal(siteLogo(page('<p>no logo</p>'), 'https://good.test'), '');
  assert.equal(siteLogo(null, 'https://good.test'), '');
});
