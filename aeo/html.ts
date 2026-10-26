import type { Res } from './types.ts';

export function header(res: Res | null, name: string): string {
  return res?.headers[name.toLowerCase()] ?? '';
}

export function isHtml(res: Res): boolean {
  return /html/i.test(header(res, 'content-type')) || /^\s*<(!doctype|html)/i.test(res.body);
}

export type OkRes = Res & { readonly ok: true };

export function isOk(res: Res | null): res is OkRes {
  return !!res && res.status >= 200 && res.status < 300;
}

export function decode(s: string): string {
  return s
    .replace(/&#(\d+);|&#x([0-9a-f]+);/gi, (m, d: string, h: string) => {
      const n = d ? Number(d) : parseInt(h, 16);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

export function tags(html: string, name: string): Record<string, string>[] {
  return [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'gi'))].map((m) => attrs(m[1]));
}

export function title(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decode(m[1]).replace(/\s+/g, ' ').trim() : '';
}

export function meta(html: string, key: string): string {
  const k = key.toLowerCase();
  for (const t of tags(html, 'meta')) if ((t.name ?? t.property ?? '').toLowerCase() === k || (t.property ?? '').toLowerCase() === k) return t.content ?? '';
  return '';
}

export function linkRel(html: string, rel: string): string[] {
  return tags(html, 'link')
    .filter((t) => (t.rel ?? '').toLowerCase().split(/\s+/).includes(rel))
    .map((t) => t.href ?? '');
}

export function anchors(html: string): { href: string; text: string }[] {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((m) => ({
    href: attrs(m[1]).href ?? '',
    text: decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(),
  }));
}

export function visibleText(html: string): string {
  return decode(
    html
      .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(header|nav|footer)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** JSON-LD nodes, flattened across arrays and @graph. */
export function jsonLd(html: string): { nodes: Record<string, unknown>[]; invalid: number } {
  const nodes: Record<string, unknown>[] = [];
  let invalid = 0;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    nodes.push(o);
    if (o['@graph']) walk(o['@graph']);
  };
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/ld\+json/i.test(attrs(m[1]).type ?? '')) continue;
    try {
      walk(JSON.parse(m[2].trim()));
    } catch {
      invalid++;
    }
  }
  return { nodes, invalid };
}

export function typesOf(node: Record<string, unknown>): string[] {
  const t = node['@type'];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string');
}

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

export function parseSitemap(xml: string): { isIndex: boolean; valid: boolean; entries: SitemapEntry[] } {
  const isIndex = /<sitemapindex\b/i.test(xml);
  const valid = isIndex || /<urlset\b/i.test(xml);
  const entries: SitemapEntry[] = [];
  for (const m of xml.matchAll(/<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const loc = /<loc>\s*([\s\S]*?)\s*<\/loc>/i.exec(m[2]);
    if (!loc) continue;
    const lastmod = /<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i.exec(m[2]);
    entries.push({ loc: decode(loc[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')), lastmod: lastmod?.[1] });
  }
  return { isIndex, valid, entries };
}
