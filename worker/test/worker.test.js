import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

class MemoryKV {
  values = new Map();
  async get(key) { return this.values.get(key) ?? null; }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

const origin = 'https://gamingpig.github.io';
const apiKey = 'test-provider-secret-never-returned';
function environment() {
  return {
    ADMIN_PASSWORD: 'test-admin-password',
    SESSION_SECRET: 'test-session-signing-secret-with-enough-entropy',
    CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    PROVIDER_API_BASE: 'https://provider.example',
    PAGES_ORIGIN: origin,
    SETTINGS: new MemoryKV()
  };
}
function request(path, { method = 'GET', body, token, requestOrigin = origin } = {}) {
  return new Request(`https://bard-worker.example${path}`, {
    method,
    headers: {
      Origin: requestOrigin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test('rejects foreign origins and protects configuration before login', async () => {
  const env = environment();
  const foreign = await worker.fetch(request('/api/health', { requestOrigin: 'https://attacker.example' }), env);
  assert.equal(foreign.status, 403);
  const locked = await worker.fetch(request('/api/admin/config'), env);
  assert.equal(locked.status, 401);
});

test('stores credentials encrypted, returns no key, and allows limited chat/image without admin login', async () => {
  const env = environment();
  const originalFetch = globalThis.fetch;
  const providerCalls = [];
  globalThis.fetch = async (url, options) => {
    providerCalls.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
    const payload = providerCalls.length === 1
      ? { candidates: [{ content: { parts: [{ text: 'Hallo Alex!' }] } }] }
      : { candidates: [{ content: { parts: [{ text: 'Bild fertig.', inlineData: { mimeType: 'image/png', data: 'cG5n' } }] } }] };
    return Response.json(payload);
  };
  try {
    const badLogin = await worker.fetch(request('/api/admin/login', { method: 'POST', body: { password: 'wrong' } }), env);
    assert.equal(badLogin.status, 401);
    const login = await worker.fetch(request('/api/admin/login', { method: 'POST', body: { password: env.ADMIN_PASSWORD } }), env);
    assert.equal(login.status, 200);
    const { accessToken } = await login.json();
    const save = await worker.fetch(request('/api/admin/config', {
      method: 'PUT', token: accessToken,
      body: { liveModel: 'private/live-model', imageModel: 'private/image-model', apiKey }
    }), env);
    assert.equal(save.status, 200);
    const stored = [...env.SETTINGS.values.values()].join('\n');
    assert.equal(stored.includes(apiKey), false);
    assert.equal(stored.includes('private/live-model'), false);
    const config = await worker.fetch(request('/api/admin/config', { token: accessToken }), env);
    const configData = await config.json();
    assert.equal(configData.apiKeyConfigured, true);
    assert.equal('apiKey' in configData, false);

    const chat = await worker.fetch(request('/api/chat', {
      method: 'POST',
      body: { userName: 'Alex', memory: ['mag Weltraum'], messages: [{ role: 'user', text: 'Sag Hallo.' }] }
    }), env);
    assert.equal(chat.status, 200);
    assert.equal((await chat.json()).text, 'Hallo Alex!');
    assert.match(providerCalls[0].url, /private\/live-model:generateContent$/);
    assert.equal(providerCalls[0].headers['x-goog-api-key'], apiKey);
    assert.match(providerCalls[0].body.systemInstruction.parts[0].text, /Gewünschte Anrede: "Alex"/);
    assert.match(providerCalls[0].body.systemInstruction.parts[0].text, /mag Weltraum/);
    assert.equal([...env.SETTINGS.values.keys()].some(key => key.startsWith('guest:') && key.includes(':chat:')), true);

    const image = await worker.fetch(request('/api/image', { method: 'POST', body: { prompt: 'Ein blauer Stern' } }), env);
    assert.equal(image.status, 200);
    assert.equal((await image.json()).image.data, 'cG5n');
    const lockedConfig = await worker.fetch(request('/api/admin/config'), env);
    assert.equal(lockedConfig.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});



test('issues model-bound ephemeral Live tokens for supported fallback models', async () => {
  const env = environment();
  const originalFetch = globalThis.fetch;
  const providerCalls = [];
  globalThis.fetch = async (url, options) => {
    providerCalls.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
    return Response.json({ name: 'temporary-live-token' });
  };
  try {
    const login = await worker.fetch(request('/api/admin/login', { method: 'POST', body: { password: env.ADMIN_PASSWORD } }), env);
    const { accessToken } = await login.json();
    const save = await worker.fetch(request('/api/admin/config', {
      method: 'PUT', token: accessToken,
      body: { liveModel: 'private/live-model', imageModel: 'private/image-model', apiKey }
    }), env);
    assert.equal(save.status, 200);

    const live = await worker.fetch(request('/api/live-token', {
      method: 'POST',
      body: { model: 'gemini-3.8-live', userName: 'Alex', voiceName: 'Puck', memory: ['mag Weltraum'], context: [{ role: 'user', text: 'Hallo' }] }
    }), env);
    assert.equal(live.status, 200);
    const payload = await live.json();
    assert.equal(payload.token, 'temporary-live-token');
    assert.equal(payload.model, 'models/gemini-3.8-live');
    assert.equal('apiKey' in payload, false);
    assert.equal(providerCalls[0].url, 'https://provider.example/v1beta/auth_tokens');
    assert.equal(providerCalls[0].headers['x-goog-api-key'], apiKey);
    assert.equal(providerCalls[0].body.liveConnectConstraints.model, 'models/gemini-3.8-live');
    assert.equal(providerCalls[0].body.liveConnectConstraints.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
    assert.match(providerCalls[0].body.liveConnectConstraints.config.systemInstruction.parts[0].text, /Gewünschte Anrede: "Alex"/);
    assert.match(providerCalls[0].body.liveConnectConstraints.config.systemInstruction.parts[0].text, /mag Weltraum/);
    assert.match(providerCalls[0].body.liveConnectConstraints.config.systemInstruction.parts[0].text, /Nutzer: Hallo/);

    const rejected = await worker.fetch(request('/api/live-token', {
      method: 'POST', body: { model: 'models/private/not-allowed' }
    }), env);
    assert.equal(rejected.status, 400);
    assert.equal(providerCalls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
