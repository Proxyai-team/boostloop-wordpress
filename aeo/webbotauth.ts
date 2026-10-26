/**
 * Web Bot Auth for the BoostLoop crawler (https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/).
 * Requests are signed with an Ed25519 key (RFC 9421 HTTP message signatures); the public key is published, itself signed,
 * at <agent>/.well-known/http-message-signatures-directory, which is also what is registered with Cloudflare's bot
 * registry. Uses only WebCrypto, so it runs in Workers and Node.
 */
const enc = new TextEncoder();

const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const b64url = (bytes: ArrayBuffer | Uint8Array) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface BotSigner {
  /** `https://boostloop.club`: the origin that hosts the key directory. */
  agent: string;
  /** Base64url JWK thumbprint of the public key (the `keyid`). */
  keyid: string;
  /** The public JWK as published in the key directory. */
  publicJwk: { kty: 'OKP'; crv: 'Ed25519'; x: string };
  /** Headers that sign one request to `url`. Short-lived: replays stop working after `ttl` seconds. */
  sign(url: string | URL, ttl?: number): Promise<Record<string, string>>;
  /** The key directory response, signed as Cloudflare's directory draft requires. `authority` is the host the verifier requested: always the agent's own host, never the Host header the app sees behind a proxy. */
  directory(authority?: string): Promise<{ body: string; headers: Record<string, string> }>;
}

export async function createBotSigner(privateJwkJson: string | undefined, agent: string): Promise<BotSigner | null> {
  if (!privateJwkJson) return null;
  // Stored either as the JWK JSON or base64 of it (env files and secret managers mangle raw JSON quotes).
  const raw = privateJwkJson.trim().startsWith('{') ? privateJwkJson : atob(privateJwkJson.trim());
  const jwk = JSON.parse(raw) as JsonWebKey;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x || !jwk.d) throw new Error('WEB_BOT_AUTH_KEY must be an Ed25519 private JWK');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign']);
  const publicJwk = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: jwk.x };
  // RFC 7638 thumbprint: required members only, sorted, no whitespace.
  const keyid = b64url(await crypto.subtle.digest('SHA-256', enc.encode(`{"crv":"Ed25519","kty":"OKP","x":"${jwk.x}"}`)));
  const agentHeader = `"${agent}"`;

  const signBase = async (base: string) => b64(await crypto.subtle.sign('Ed25519', key, enc.encode(base)));
  const nonce = () => b64(crypto.getRandomValues(new Uint8Array(48)));

  return {
    agent,
    keyid,
    publicJwk,
    async sign(url, ttl = 60) {
      const u = new URL(url);
      const created = Math.floor(Date.now() / 1000);
      const params = `("@authority" "signature-agent");created=${created};keyid="${keyid}";alg="ed25519";expires=${created + ttl};nonce="${nonce()}";tag="web-bot-auth"`;
      const base = `"@authority": ${u.host}\n"signature-agent": ${agentHeader}\n"@signature-params": ${params}`;
      return { 'signature-agent': agentHeader, 'signature-input': `sig1=${params}`, signature: `sig1=:${await signBase(base)}:` };
    },
    async directory(authority = new URL(agent).host) {
      const created = Math.floor(Date.now() / 1000);
      const params = `("@authority";req);alg="ed25519";keyid="${keyid}";nonce="${nonce()}";tag="http-message-signatures-directory";created=${created};expires=${created + 300}`;
      const base = `"@authority";req: ${authority}\n"@signature-params": ${params}`;
      return {
        body: JSON.stringify({ keys: [publicJwk] }),
        headers: {
          'content-type': 'application/http-message-signatures-directory+json',
          'signature-input': `sig1=${params}`,
          signature: `sig1=:${await signBase(base)}:`,
          // Shorter than the signature's life (300s), so a cached copy never carries an expired signature.
          'cache-control': 'max-age=60',
        },
      };
    },
  };
}

/** A fresh Ed25519 key pair as JWKs, for first-time setup (see scripts/web-bot-auth-keygen.mjs). */
export async function generateBotKey() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return { privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey), publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey) };
}
