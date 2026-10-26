export interface Page {
  status?: number;
  type?: string;
  headers?: Record<string, string>;
  body?: string;
}
export type Site = Record<string, Page>;

const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();

const GOOD_HOME = `<!doctype html><html><head><title>Acme Coffee Roasters</title>
<meta name="description" content="Acme sells small-batch roasted coffee beans to home brewers across the US.">
<link rel="canonical" href="https://good.test/"><meta property="og:title" content="Acme"><meta property="og:image" content="https://good.test/og.png">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Acme","sameAs":["https://twitter.com/acme","https://www.wikidata.org/wiki/Q1"]},{"@type":"WebSite","url":"https://good.test/"}]}</script>
</head><body><main><h1>Acme Coffee</h1><p>${'We roast small-batch coffee for home brewers and ship it fresh within two days of roasting. '.repeat(4)}</p>
<a href="/products/ethiopia">Ethiopia <img src="a.jpg" alt="bag"></a>
<label for="q">Search</label><input id="q" type="text"><button>Go</button></main>
<footer><a href="/about">About</a><a href="/contact">Contact</a><a href="/shipping">Shipping</a><a href="/returns">Returns</a><a href="/privacy">Privacy</a></footer></body></html>`;

const GOOD_PRODUCT = `<html><head><title>Ethiopia</title><script type="application/ld+json">{"@type":"Product","name":"Ethiopia","offers":{"@type":"Offer","price":"18.00","priceCurrency":"USD"}}</script></head><body>$18.00</body></html>`;

export const goodShop: Site = {
  '/': { body: GOOD_HOME, headers: { link: '</sitemap.xml>; rel="sitemap"' } },
  '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /\nContent-Signal: ai-train=no, search=yes, ai-input=yes\nSitemap: https://good.test/sitemap.xml\n' },
  '/sitemap.xml': { type: 'application/xml', body: `<urlset><url><loc>https://good.test/products/ethiopia</loc><lastmod>${recent}</lastmod></url><url><loc>https://good.test/about</loc><lastmod>${recent}</lastmod></url></urlset>` },
  '/products/ethiopia': { body: GOOD_PRODUCT },
  '/products/ethiopia.md': { type: 'text/markdown', body: '# Ethiopia\n$18' },
  '/index.md': { type: 'text/markdown', body: '# Acme' },
  '/pricing.md': { type: 'text/markdown', body: '# Pricing\n$18' },
  '/llms.txt': { type: 'text/plain', body: '# Acme\n\n> Coffee\n\n- [Ethiopia](https://good.test/products/ethiopia): beans\n- [About](/about): us\n' },
  '/about': { body: '<html>about</html>' },
  '/products.json': { type: 'application/json', body: '{"products":[]}' },
  '/.well-known/ucp': { type: 'application/json', body: '{}' },
  '/.well-known/acp.json': { type: 'application/json', body: '{}' },
  '/.well-known/ap2.json': { type: 'application/json', body: '{}' },
  '/.well-known/mpp': { type: 'application/json', body: '{}' },
  '/.well-known/x402': { type: 'application/json', body: '{}' },
};

export const badShop: Site = {
  '/': {
    body: `<html><head><title>Home</title><meta name="robots" content="noindex"></head><body><div onclick="go()">x</div><a href="/x"></a><img src="a.jpg"><input type="text"></body></html>`,
  },
  '/robots.txt': { type: 'text/plain', body: 'User-agent: OAI-SearchBot\nDisallow: /\nUser-agent: PerplexityBot\nDisallow: /\nUser-agent: ChatGPT-User\nDisallow: /\nUser-agent: Claude-SearchBot\nDisallow: /\n' },
  '/sitemap.xml': { status: 404 },
  '/wp-sitemap.xml': { status: 404 },
  '/llms.txt': { status: 404 },
  '/index.md': { status: 404 },
  '/pricing.md': { status: 404 },
  // soft 404: every unknown path serves the homepage
  '*': { body: '<html><head><title>Home</title></head><body>hello</body></html>' },
};

export const wafSite: Site = {
  '/': { status: 403, headers: { 'cf-mitigated': 'challenge' }, body: '<html><title>Just a moment...</title></html>' },
  '*': { status: 403, body: 'blocked' },
};

export const robotsBlocked: Site = {
  '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /\n' },
  '*': { body: '<html>x</html>' },
};

/** Fake fetch serving a Site by pathname (host-agnostic). Unknown paths 404 unless site has '*'. */
export function fakeFetch(site: Site, log?: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    log?.push(u.pathname + u.search);
    const accept = new Headers(init?.headers).get('accept') ?? '';
    const key = u.pathname === '/' && accept.includes('markdown') && site['/@md'] ? '/@md' : u.pathname;
    const page = site[key] ?? site['*'] ?? { status: 404 };
    return new Response(page.body ?? '', {
      status: page.status ?? 200,
      headers: { 'content-type': page.type ?? 'text/html', ...page.headers },
    });
  }) as typeof fetch;
}
