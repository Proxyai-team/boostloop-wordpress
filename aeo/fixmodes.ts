import type { Platform } from './types.ts';

/** auto = app/plugin can write the fix, prompt = copy the prompt, scan = report only. */
export type FixMode = 'auto' | 'prompt' | 'scan';

/** Per check id, per platform (docs/aeo-check-catalogue.md). Plain sites are always prompt-only. */
const FIX_MODES: Record<number, Record<'wordpress' | 'shopify', FixMode>> = {
  1: { wordpress: 'auto', shopify: 'auto' },
  2: { wordpress: 'auto', shopify: 'auto' },
  3: { wordpress: 'auto', shopify: 'auto' },
  4: { wordpress: 'auto', shopify: 'scan' },
  5: { wordpress: 'prompt', shopify: 'scan' },
  6: { wordpress: 'scan', shopify: 'scan' },
  8: { wordpress: 'auto', shopify: 'auto' },
  9: { wordpress: 'auto', shopify: 'auto' },
  10: { wordpress: 'auto', shopify: 'auto' },
  11: { wordpress: 'auto', shopify: 'scan' },
  12: { wordpress: 'auto', shopify: 'auto' },
  13: { wordpress: 'auto', shopify: 'auto' },
  14: { wordpress: 'auto', shopify: 'prompt' },
  15: { wordpress: 'auto', shopify: 'auto' },
  16: { wordpress: 'auto', shopify: 'auto' },
  17: { wordpress: 'auto', shopify: 'auto' },
  18: { wordpress: 'auto', shopify: 'scan' },
  19: { wordpress: 'auto', shopify: 'auto' },
  20: { wordpress: 'auto', shopify: 'scan' },
  22: { wordpress: 'auto', shopify: 'scan' },
  26: { wordpress: 'scan', shopify: 'scan' },
  27: { wordpress: 'auto', shopify: 'auto' },
  29: { wordpress: 'auto', shopify: 'auto' },
  32: { wordpress: 'auto', shopify: 'scan' },
  33: { wordpress: 'auto', shopify: 'scan' },
  34: { wordpress: 'auto', shopify: 'scan' },
  35: { wordpress: 'auto', shopify: 'scan' },
  36: { wordpress: 'auto', shopify: 'scan' },
};

export function fixModeFor(checkId: number, platform: Platform): FixMode | null {
  const row = FIX_MODES[checkId];
  if (!row) return null;
  return platform === 'website' ? 'prompt' : row[platform];
}

/** Checks the WordPress plugin can fix. 5 (needs real modification dates), 6 (an external firewall) and 26 (theme markup) cannot be fixed from a plugin. */
export const WORDPRESS_PLUGIN_FIXES = [1, 2, 3, 4, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 27, 29, 32, 33, 34, 35, 36];

/** Checks the Shopify app can fix: head tags through a theme app embed, drafted pages, robots.txt.liquid, and theme assets redirected from the real path (llms.txt, .md). Check 14 stays a prompt: its homepage section has no place to land on a Shopify store yet. Sitemap, headers, 404s and noindex belong to Shopify itself. */
export const SHOPIFY_APP_FIXES = [1, 2, 3, 8, 9, 10, 12, 13, 15, 16, 17, 19, 27, 29];

export const appFixesFor = (platform: 'wordpress' | 'shopify') => (platform === 'shopify' ? SHOPIFY_APP_FIXES : WORDPRESS_PLUGIN_FIXES);
