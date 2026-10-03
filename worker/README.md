# Legacy Cloudflare Worker (not used by the current PWA)

The current Bard AI PWA on GitHub Pages connects directly to Google Gemini. It has no Worker URL, provider-settings panel, or admin-password requirement. Its provider key and model IDs are transferred once from the locally installed Bard AI Edge extension and then stored encrypted in the PWA's browser storage.

Do not follow the historical deployment steps in this folder for the current PWA. This Worker source remains only as an unused legacy option. The current static PWA cannot keep a client-side API key secret; use a backend proxy if server-side secret isolation is required.

