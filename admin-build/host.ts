/**
 * The WordPress plugin's version of `lib/host.ts` (the build swaps it in; same exports). The screens call
 * `/api/<path>` as on the site; here that becomes this WordPress site's own REST route `boostloop/v1/api/<path>`,
 * which checks the admin's cookie, nonce and capability, then PHP forwards it to BoostLoop with the site secret.
 * The browser never holds a BoostLoop credential.
 */
type Config = { restUrl: string; nonce: string; assetsUrl: string; appUrl: string; pageUrl: string; ajaxUrl: string };
const config = () => (window as unknown as { BoostLoopWP: Config }).BoostLoopWP;

export const inPlugin = true;

let nonce = '';

/** A route on this site's REST API, for pretty and plain permalinks alike. */
function rest(route: string, query?: URLSearchParams): string {
  const url = new URL(config().restUrl, window.location.href);
  if (url.searchParams.has('rest_route')) url.searchParams.set('rest_route', '/' + route);
  else url.pathname = url.pathname.replace(/\/?$/, '/') + route;
  query?.forEach((v, k) => url.searchParams.append(k, v));
  return url.toString();
}

function split(path: string): [string, URLSearchParams] {
  const [p, q = ''] = path.replace(/^\//, '').split('?');
  return [p, new URLSearchParams(q)];
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const [p, query] = split(path);
  const send = () => {
    const headers = new Headers(init.headers);
    headers.set('X-WP-Nonce', nonce || config().nonce);
    // Some hosts refuse PATCH/DELETE; WordPress honours the override header (as core's apiFetch does).
    let method = (init.method ?? 'GET').toUpperCase();
    if (method === 'PATCH' || method === 'DELETE') { headers.set('X-HTTP-Method-Override', method); method = 'POST'; }
    return fetch(rest('boostloop/v1/api/' + p, query), { ...init, method, headers, credentials: 'same-origin' });
  };
  let res = await send();
  // The page's nonce expires after a day; core's own `rest-nonce` ajax action issues a fresh one.
  if (res.status === 403 && ((await res.clone().json().catch(() => null)) as { code?: string } | null)?.code === 'rest_cookie_invalid_nonce') {
    const fresh = await fetch(config().ajaxUrl + '?action=rest-nonce', { credentials: 'same-origin' }).then((r) => r.text()).catch(() => '');
    if (/^[a-f0-9]{6,}$/i.test(fresh.trim())) { nonce = fresh.trim(); res = await send(); }
  }
  return res;
}

/** A call to this WordPress site's own `boostloop/v1/<route>` (never forwarded to BoostLoop), e.g. approving a draft. */
export function localRest(route: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('X-WP-Nonce', nonce || config().nonce);
  if (init.body) headers.set('Content-Type', 'application/json');
  return fetch(rest('boostloop/v1/' + route), { ...init, headers, credentials: 'same-origin' });
}

/** `<img>` cannot send the nonce header; WordPress accepts it as `_wpnonce` for cookie-authenticated GETs. */
export function apiUrl(path: string): string {
  const [p, query] = split(path);
  query.set('_wpnonce', nonce || config().nonce);
  return rest('boostloop/v1/api/' + p, query);
}

export function viewHref(view: string, id = ''): string {
  const url = new URL(config().pageUrl);
  url.searchParams.set('view', view);
  if (id) url.searchParams.set('id', id); else url.searchParams.delete('id');
  return url.toString();
}

/** Logos and MCP skills ship inside the plugin; nothing loads from BoostLoop at runtime. */
export function asset(path: string): string {
  return config().assetsUrl + path.replace(/^\//, '');
}

export function appOrigin(): string {
  return new URL(config().appUrl).origin;
}
