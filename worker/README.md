# Bard AI API worker

This Cloudflare Worker keeps provider credentials and the admin password out of the public GitHub Pages app. The Pages frontend is static and cannot safely hold secrets.

## Create and configure the Worker

1. Install Node.js and run `npm install` in this directory.
2. Sign in to Cloudflare with `npx wrangler login`.
3. Create the encrypted settings store with `npx wrangler kv namespace create bard-ai-settings`. Copy the returned namespace ID into `wrangler.toml`, replacing the placeholder.
4. Add the Worker secrets below. Each command prompts for its value; type it into the prompt so it is not added to this repository or shell history:

   ```powershell
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put CONFIG_ENCRYPTION_KEY
   npx wrangler secret put PROVIDER_API_BASE
   ```

   Generate a different random value for each of the session and encryption secrets, then paste each value only into the Wrangler prompt:

   ```powershell
   $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
   $bytes = New-Object byte[] 32
   $rng.GetBytes($bytes)
   [Convert]::ToBase64String($bytes)
   $rng.Dispose()
   ```

   - `ADMIN_PASSWORD`: the admin password chosen for this app.
   - `SESSION_SECRET`: the first unique random value.
   - `CONFIG_ENCRYPTION_KEY`: the second random value, encoding 32 bytes. Keep a secure backup: losing it makes the saved encrypted provider configuration unreadable.
   - `PROVIDER_API_BASE`: the HTTPS origin of the compatible provider API. The Google Gemini API origin is `https://generativelanguage.googleapis.com`.

5. Deploy with `npm run deploy`. Copy the resulting `https://…workers.dev` address into Bard AI’s Admin & Verbindung dialog.
6. Unlock the admin panel and enter the provider model IDs and API key. The Worker encrypts them before storing them in KV; the key is never returned to the browser. Leave the API-key field blank to keep the current key.

The Worker allows browser requests from `https://gamingpig.github.io`, protects provider configuration with a short-lived signed admin session, and rate-limits password attempts. Chat and image generation do not require the admin password; they use per-IP daily limits (60 chat requests and 8 image requests) to bound public use. CORS is a browser restriction rather than authentication, so set appropriate provider billing limits and rotate keys if abuse is suspected. Changing the Pages hostname requires changing `PAGES_ORIGIN` in `wrangler.toml` and redeploying.

## Local checks

Run `npm run check` to parse the Worker source. `npm run dev` starts the local Wrangler preview after the KV binding and secrets have been configured for local development.

Provider availability, pricing, model limits, and image-generation quotas are controlled by the selected provider. This project cannot promise unlimited or quota-free generation.

