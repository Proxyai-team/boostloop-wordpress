import test from 'node:test';
import assert from 'node:assert/strict';
import { createFetcher } from './fetcher.ts';
import { createBotSigner, generateBotKey } from './webbotauth.ts';

const noSleep = async () => {};
type Seen = { url: string; headers: Record<string, string> };
function fakeFetch(respond: (url: string) => Response) {
  const seen: Seen[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string> });
    return respond(url);
  }) as unknown as typeof fetch;
  return { seen, impl };
}
const robots = (url: string) => (url.endsWith('/robots.txt') ? new Response('User-agent: *\nAllow: /\n') : new Response('ok'));

test('every request is signed when a signer is configured, bound to its own host', async () => {
  const signer = await createBotSigner(JSON.stringify((await generateBotKey()).privateJwk), 'https://bot.test');
  const { seen, impl } = fakeFetch(robots);
  await createFetcher({ fetchImpl: impl, sleep: noSleep, signer }).get('https://shop.test/');
  assert.ok(seen.length >= 2);
  for (const s of seen) {
    assert.equal(s.headers['signature-agent'], '"https://bot.test"');
    assert.match(s.headers['signature-input'], /^sig1=\("@authority" "signature-agent"\)/);
    assert.match(s.headers.signature, /^sig1=:/);
  }
});

test('no signer, no signature headers', async () => {
  const { seen, impl } = fakeFetch(robots);
  await createFetcher({ fetchImpl: impl, sleep: noSleep }).get('https://shop.test/');
  assert.ok(seen.every((s) => !('signature' in s.headers)));
});

test("a merchant's own signature goes to their host only, not to a redirect target elsewhere", async () => {
  const { seen, impl } = fakeFetch((url) => (url === 'https://shop.test/' ? new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }) : robots(url)));
  const siteHeaders = { 'shop.test': { 'signature-agent': '"https://shopify.com"', 'signature-input': 'sig=1', signature: 'sig=:abc:' } };
  await createFetcher({ fetchImpl: impl, sleep: noSleep, siteHeaders }).get('https://shop.test/');
  const to = (host: string) => seen.filter((s) => new URL(s.url).host === host);
  assert.ok(to('shop.test').length > 0 && to('shop.test').every((s) => s.headers.signature === 'sig=:abc:'));
  assert.ok(to('elsewhere.test').length > 0 && to('elsewhere.test').every((s) => !('signature' in s.headers) && !('signature-agent' in s.headers)));
});

test("the merchant's signature replaces ours on their host", async () => {
  const signer = await createBotSigner(JSON.stringify((await generateBotKey()).privateJwk), 'https://bot.test');
  const { seen, impl } = fakeFetch(robots);
  const siteHeaders = { 'shop.test': { 'signature-agent': '"https://shopify.com"', 'signature-input': 'sig=1', signature: 'sig=:abc:' } };
  await createFetcher({ fetchImpl: impl, sleep: noSleep, signer, siteHeaders }).get('https://shop.test/');
  assert.ok(seen.every((s) => s.headers['signature-agent'] === '"https://shopify.com"'));
});

test('429 and 503 with Retry-After count as rate limiting; other errors do not', async () => {
  const statuses = new Map([['https://shop.test/a', new Response('', { status: 429 })], ['https://shop.test/b', new Response('', { status: 503, headers: { 'retry-after': '5' } })], ['https://shop.test/c', new Response('', { status: 503 })], ['https://shop.test/d', new Response('', { status: 404 })]]);
  const { impl } = fakeFetch((url) => (url.endsWith('/robots.txt') ? new Response('User-agent: *\nAllow: /\n') : statuses.get(url)!));
  const f = createFetcher({ fetchImpl: impl, sleep: noSleep });
  for (const p of ['a', 'b', 'c', 'd']) await f.get(`https://shop.test/${p}`);
  assert.equal(f.stats.rateLimited, 2);
});
