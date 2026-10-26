/**
 * Builds the WordPress plugin's admin screen from the BoostLoop site's own screens:
 *   npx vite build --config plugins/wordpress/admin-build/vite.config.ts
 * Output: plugins/wordpress/boostloop-aeo/admin/dist (one JS, one CSS, logos, MCP skills). Not minified, and nothing
 * loads from a remote server (WordPress.org guidelines 4 and 8); the readme points here for the source.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import type { AtRule, Plugin as PostcssPlugin, Rule } from 'postcss';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const outDir = path.resolve(here, '../boostloop-aeo/admin/dist');
const SCOPE = '#boostloop-app';

/** `lib/host.ts` → this folder's `host.ts`, so the shared screens talk to WordPress instead of the site. */
function wordpressHost(): Plugin {
  const web = path.join(root, 'lib/host.ts');
  return {
    name: 'boostloop-wordpress-host',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!/(^|\/)host(\.ts)?$/.test(source) || !importer) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved?.id === web ? path.join(here, 'host.ts') : null;
    },
  };
}

/** Scopes the site's global stylesheet under #boostloop-app so it cannot restyle wp-admin; drops remote @imports. */
function scopeCss(): PostcssPlugin {
  const scoped = new WeakSet<Rule>();
  return {
    postcssPlugin: 'boostloop-wp-scope',
    AtRule: { import(rule) { if (/https?:/.test(rule.params)) rule.remove(); } },
    Rule(rule) {
      const parent = rule.parent as AtRule | undefined;
      if (parent?.type === 'atrule' && /keyframes/.test(parent.name)) return;
      if (scoped.has(rule)) return;
      scoped.add(rule);
      rule.selector = rule.selector.split(',').map((s) => {
        const sel = s.trim();
        if (/^(html|body|:root)$/.test(sel)) return SCOPE;
        return `${SCOPE} ${sel.replace(/^(html|body|:root)\s+/, '')}`;
      }).join(',');
    },
  };
}

function copyAssets(): Plugin {
  return {
    name: 'boostloop-plugin-assets',
    writeBundle() {
      const files = ['brand/boostloop-horizontal.svg', 'brand/boostloop-icon.svg', 'skills/boostloop-setup/SKILL.md', 'skills/boostloop-operations/SKILL.md'];
      for (const f of files) {
        fs.mkdirSync(path.dirname(path.join(outDir, 'public', f)), { recursive: true });
        fs.copyFileSync(path.join(root, 'public', f), path.join(outDir, 'public', f));
      }
    },
  };
}

export default defineConfig({
  root: here,
  plugins: [wordpressHost(), react(), copyAssets()],
  css: { postcss: { plugins: [scopeCss()] } },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir,
    emptyOutDir: true,
    minify: false,
    cssCodeSplit: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
    lib: { entry: path.join(here, 'main.tsx'), formats: ['iife'], name: 'BoostLoopAdmin', fileName: () => 'boostloop-admin.js', cssFileName: 'boostloop-admin' },
  },
});
