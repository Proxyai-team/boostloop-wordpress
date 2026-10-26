# BoostLoop for WordPress

[BoostLoop](https://boostloop.club) plugin for wp-admin: scan your site for AI-agent readiness (AEO), auto-fix it (robots.txt, JSON-LD, metadata, llms.txt, markdown pages), and run campaigns.

- `boostloop-aeo/` — the plugin, as shipped (no minification; nothing loads from a remote server).
- `admin-build/` — Vite config and WordPress host shim used to build `boostloop-aeo/admin/dist`. The admin screens are shared with the BoostLoop web app, so a full rebuild needs that app's `components/` and `app/` folders; the built bundle here is unminified.

## Security

No credentials are stored in this repo. On first connect the plugin generates a random per-site secret (`random_bytes(32)`), stores it in that site's options table, and uses it only to authenticate requests from that site to BoostLoop. Staging can override the endpoint with `define('BOOSTLOOP_AEO_APP', ...)` in `wp-config.php`.

## License

GPLv2 or later. See `LICENSE`.
