# Bard AI

Bard AI is a mobile-ready installable PWA with its entry page and linked assets in the repository root. It includes a light/dark theme, multiple independent local conversations, a remembered user name and editable local memory, voice input/output, image requests, and locally encrypted provider settings. Each conversation keeps its own message context and can be reopened from the chat list; name and memory are shared across conversations.

## Publish

GitHub Actions stages only the PWA entry page, styles, scripts, manifest, service worker, and Bard icons from the repository root, then publishes that app to GitHub Pages on updates to `main`. The app URL is `https://gamingpig.github.io/Bard-AI/`. If Pages has not been enabled for the repository yet, open **Settings → Pages** and choose **GitHub Actions** as the build source.

The PWA calls the Google Gemini API directly, so it does not require a separately deployed backend or admin password. Enter a Gemini API key and model IDs in Settings once. The key and model IDs are encrypted with AES-GCM and stored in IndexedDB on that browser; the non-exportable device key is stored alongside them. The app decrypts the settings in memory to make requests. This protects stored values from casual inspection, but it cannot hide an API key from someone who can run or inspect the public app in that browser. Restrict the key to the Gemini API and the Bard AI Pages origin. The browser keeps separate chat histories, display name, and up to 12 memory facts locally; each chat retains up to 80 messages and 8 generated images.

The PWA uses browser speech recognition and speech synthesis for voice interaction. It does not yet implement Gemini Live streaming, camera/screen capture, desktop control, or Office/document generation. Image and model availability depends on the provider's current pricing and quotas; unlimited generation cannot be guaranteed.

The browser extension source is intentionally not included in this public Pages repository.

