# Bard AI

Bard AI is a mobile-ready installable PWA with its entry page and linked assets in the repository root. It includes a light/dark theme, local conversation history, remembered display name, voice input/output, image requests, and a password-protected provider settings dialog.

## Publish

GitHub Actions stages only the PWA entry page, styles, scripts, manifest, service worker, and Bard icons from the repository root, then publishes that app to GitHub Pages on updates to `main`. The app URL is `https://gamingpig.github.io/Bard-AI/`. If Pages has not been enabled for the repository yet, open **Settings → Pages** and choose **GitHub Actions** as the build source.

The PWA needs a separately deployed Cloudflare Worker before chat and image generation can connect. Follow [worker/README.md](worker/README.md). API keys, the admin password, provider endpoint, model IDs, and encryption material are not embedded in the public frontend. The browser remembers the Worker URL and display name locally; chat history is limited to the latest 80 messages and 8 retained images per device.

The PWA uses browser speech recognition and speech synthesis for voice interaction. It does not yet implement Gemini Live streaming, camera/screen capture, desktop control, or Office/document generation. Image and model availability depends on the provider's current pricing and quotas; unlimited generation cannot be guaranteed.

The browser extension source is intentionally not included in this public Pages repository.
