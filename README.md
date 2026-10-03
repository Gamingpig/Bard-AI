# Bard AI

Bard AI is a mobile-ready installable PWA with a light/dark theme, multiple local chats, remembered name and memory, voice input/output, and image requests. Provider credentials and model IDs are stored locally with AES-GCM.

## First connection

The PWA has no provider-settings or admin-password menu. In Microsoft Edge, open the Bard AI extension and choose **Settings → Advanced → Developer/Provider → Vorhandenen Schlüssel in PWA übernehmen** once. The extension asks before sending its existing Gemini key; the PWA then discovers available models, selects suitable defaults, and stores the key and model IDs encrypted in that browser. Later PWA launches reuse that local configuration automatically. A website and an extension have separate browser storage, so this one-time transfer is required. No API key is included in this repository.

## Publish

GitHub Actions stages the PWA entry page, styles, scripts, manifest, service worker, and Bard icons from the repository root, then publishes to GitHub Pages at `https://gamingpig.github.io/Bard-AI/` on updates to `main`.

AES-GCM protects the saved settings at rest in the browser. The page decrypts the key in memory to make requests to Google Gemini, so a public static site cannot make a client-side key secret from someone able to inspect or run the site. Restrict the key to Gemini API use and set provider usage limits. Provider model availability, image access, pricing, and quotas are controlled by Google; unlimited generation cannot be guaranteed.

The PWA keeps separate chat histories, display name, and up to 12 memory facts locally; each chat retains up to 80 messages and 8 generated images. It uses browser speech recognition and speech synthesis. It does not implement Gemini Live streaming, camera/screen capture, desktop control, or Office/document generation.

The browser extension source is intentionally not included in this public Pages repository.

