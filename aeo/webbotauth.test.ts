import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotSigner, generateBotKey } from './webbotauth.ts';

const b64d = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const AGENT = 'https://bot.test';

async function setup() {
  const { privateJwk } = await generateBotKey();
  const signer = (await createBotSigner(JSON.stringify(privateJwk), AGENT))!;
  const pub = await crypto.subtle.importKey('jwk', signer.publicJwk, { name: 'Ed25519' }, false, ['verify']);
  return { signer, pub };
}

test('no key configured means no signer', async () => {
  assert.equal(await createBotSigner(undefined, AGENT), null);
});

test('rejects keys that are not Ed25519 private JWKs', async () => {
  await assert.rejects(createBotSigner(JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'abc' }), AGENT), /private JWK/);
});

test('request signature verifies over the documented signature base, and carries the three required headers', async () => {
  const { signer, pub } = await setup();
  const h = await signer.sign('https://shop.test/products/a?x=1');
  assert.equal(h['signature-agent'], '"https://bot.test"', 'Signature-Agent is a quoted structured string');
  const params = h['signature-input'].replace(/^sig1=/, '');
  assert.match(params, /^\("@authority" "signature-agent"\);created=\d+;keyid="[\w-]+";alg="ed25519";expires=\d+;nonce="[^"]+";tag="web-bot-auth"$/);
  assert.ok(params.includes(`keyid="${signer.keyid}"`));
  const [, created, expires] = /created=(\d+).*expires=(\d+)/.exec(params)!.map(Number);
  assert.equal(expires - created, 60, 'short-lived');
  const base = `"@authority": shop.test\n"signature-agent": "https://bot.test"\n"@signature-params": ${params}`;
  const sig = /^sig1=:(.+):$/.exec(h.signature)![1];
  assert.equal(await crypto.subtle.verify('Ed25519', pub, b64d(sig), new TextEncoder().encode(base)), true);
  assert.equal(await crypto.subtle.verify('Ed25519', pub, b64d(sig), new TextEncoder().encode(base.replace('shop.test', 'evil.test'))), false, 'bound to the authority');
});

test('the authority includes a non-default port, like the Host header', async () => {
  const { signer, pub } = await setup();
  const h = await signer.sign('https://shop.test:8443/');
  const base = `"@authority": shop.test:8443\n"signature-agent": "https://bot.test"\n"@signature-params": ${h['signature-input'].replace(/^sig1=/, '')}`;
  assert.equal(await crypto.subtle.verify('Ed25519', pub, b64d(/^sig1=:(.+):$/.exec(h.signature)![1]), new TextEncoder().encode(base)), true);
});

test('each signature has its own nonce', async () => {
  const { signer } = await setup();
  const a = await signer.sign('https://shop.test/');
  const b = await signer.sign('https://shop.test/');
  assert.notEqual(a['signature-input'], b['signature-input']);
});

test('key directory: public key only, the registry content type, and a verifiable signature over @authority', async () => {
  const { signer, pub } = await setup();
  const d = await signer.directory('bot.test');
  const body = JSON.parse(d.body);
  assert.deepEqual(Object.keys(body.keys[0]).sort(), ['crv', 'kty', 'x'], 'never the private d');
  assert.equal(d.headers['content-type'], 'application/http-message-signatures-directory+json');
  assert.ok(Number(/max-age=(\d+)/.exec(d.headers['cache-control'])![1]) < Number(/expires=(\d+)/.exec(d.headers['signature-input'])![1]) - Number(/created=(\d+)/.exec(d.headers['signature-input'])![1]), 'cacheable for less time than the signature is valid');
  const params = d.headers['signature-input'].replace(/^sig1=/, '');
  assert.match(params, /^\("@authority";req\);alg="ed25519";keyid="[\w-]+";nonce="[^"]+";tag="http-message-signatures-directory";created=\d+;expires=\d+$/);
  const base = `"@authority";req: bot.test\n"@signature-params": ${params}`;
  assert.equal(await crypto.subtle.verify('Ed25519', pub, b64d(/^sig1=:(.+):$/.exec(d.headers.signature)![1]), new TextEncoder().encode(base)), true);
});

test('the directory is signed for the agent host by default, whatever host the app sees behind a proxy', async () => {
  const { signer, pub } = await setup();
  const d = await signer.directory();
  const base = `"@authority";req: bot.test\n"@signature-params": ${d.headers['signature-input'].replace(/^sig1=/, '')}`;
  assert.equal(await crypto.subtle.verify('Ed25519', pub, b64d(/^sig1=:(.+):$/.exec(d.headers.signature)![1]), new TextEncoder().encode(base)), true);
});

test('keyid is the RFC 8037 thumbprint of the published key', async () => {
  const { signer } = await setup();
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${signer.publicJwk.x}"}`;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
  assert.equal(signer.keyid, btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
});

test('the key can be supplied as base64 of the JWK, which env files keep intact', async () => {
  const { privateJwk } = await generateBotKey();
  const a = await createBotSigner(JSON.stringify(privateJwk), AGENT);
  const b = await createBotSigner(btoa(JSON.stringify(privateJwk)), AGENT);
  assert.equal(a!.keyid, b!.keyid);
});
