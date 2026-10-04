import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

class MemoryKV {
  values = new Map();
  async get(key) { return this.values.get(key) ?? null; }
  async put(key, value) { this.values.set(key, value); }
}

const origin = 'https://gamingpig.github.io';
const apiKey = 'test-provider-secret-never-returned';
function environment(overrides = {}) {
  return {
    GEMINI_API_KEY: apiKey,
    CHAT_MODEL: 'gemini-3.8-flash',
    IMAGE_MODEL: 'gemini-3.1-flash-lite-image',
    PROVIDER_API_BASE: 'https://generativelanguage.googleapis.com',
    PAGES_ORIGIN: origin,
    SETTINGS: new MemoryKV(),
    ...overrides
  };
}
function request(path, { method = 'GET', body, requestOrigin = origin } = {}) {
  return new Request(`https://bard-worker.example${path}`, {
    method,
    headers: {
      Origin: requestOrigin,
      'CF-Connecting-IP': '203.0.113.42',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test('rejects foreign origins and removes the old admin setup routes', async () => {
  const env = environment();
  const foreign = await worker.fetch(request('/api/health', { requestOrigin: 'https://attacker.example' }), env);
  assert.equal(foreign.status, 403);
  const oldLogin = await worker.fetch(request('/api/admin/login', { method: 'POST', body: { password: 'unused' } }), env);
  assert.equal(oldLogin.status, 404);
  const oldConfig = await worker.fetch(request('/api/admin/config'), env);
  assert.equal(oldConfig.status, 404);
});

test('serves chat and image through a server-held provider secret and limits per-IP use', async () => {
  const env = environment();
  const originalFetch = globalThis.fetch;
  const providerCalls = [];
  globalThis.fetch = async (url, options) => {
    providerCalls.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
    const payload = providerCalls.length === 1
      ? { candidates: [{ content: { parts: [{ text: 'Hallo Alex!' }] }, groundingMetadata: { searchEntryPoint: { renderedContent: '<div>Search suggestions</div>' }, groundingChunks: [{ web: { title: 'Beispielquelle', uri: 'https://example.com/source' } }] } }] }
      : { candidates: [{ content: { parts: [{ text: 'Bild fertig.', inlineData: { mimeType: 'image/png', data: 'cG5n' } }] } }] };
    return Response.json(payload);
  };
  try {
    const chat = await worker.fetch(request('/api/chat', {
      method: 'POST',
      body: { userName: 'Alex', memory: ['mag Weltraum'], context: [{ role: 'user', text: 'Wir sprachen über meinen Hund Fips.' }], messages: [{ role: 'user', text: 'Sag Hallo.' }] }
    }), env);
    assert.equal(chat.status, 200);
    const chatData = await chat.json();
    assert.equal(chatData.text, 'Hallo Alex!');
    assert.equal(chatData.sources[0].title, 'Beispielquelle');
    assert.equal(chatData.sources[0].url, 'https://example.com/source');
    assert.equal(chatData.searchSuggestion, '<div>Search suggestions</div>');
    assert.equal(JSON.stringify(chatData).includes(apiKey), false);
    assert.match(providerCalls[0].url, /gemini-3\.8-flash:generateContent$/);
    assert.equal(providerCalls[0].headers['x-goog-api-key'], apiKey);
    assert.match(providerCalls[0].body.systemInstruction.parts[0].text, /Gewünschte Anrede: "Alex"/);
    assert.match(providerCalls[0].body.systemInstruction.parts[0].text, /mag Weltraum/);
    assert.match(providerCalls[0].body.systemInstruction.parts[0].text, /Hund Fips/);
    assert.deepEqual(providerCalls[0].body.tools, [{ google_search: {} }]);
    assert.equal([...env.SETTINGS.values.keys()].some(key => key.startsWith('guest:') && key.includes(':chat:')), true);

    const image = await worker.fetch(request('/api/image', { method: 'POST', body: { prompt: 'Ein blauer Stern', context: [{ role: 'user', text: 'Der Stern soll zu meinem Märchen über einen Fuchs passen.' }] } }), env);
    assert.equal(image.status, 200);
    assert.equal((await image.json()).image.data, 'cG5n');
    assert.match(providerCalls[1].url, /gemini-3\.1-flash-lite-image:generateContent$/);
    assert.equal(providerCalls[1].headers['x-goog-api-key'], apiKey);
    assert.match(providerCalls[1].body.contents[0].parts[0].text, /Märchen über einen Fuchs/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generates voice previews through the server-held key and rejects unknown voices', async () => {
  const env = environment();
  const originalFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url: String(url), headers: options.headers, body: JSON.parse(options.body) };
    return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: 'UklGRg==' } }] } }] });
  };
  try {
    const response = await worker.fetch(request('/api/voice-preview', {
      method: 'POST', body: { voiceName: 'Kore' }
    }), env);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.voiceName, 'Kore');
    assert.equal(result.mimeType, 'audio/wav');
    assert.equal(result.data, 'UklGRg==');
    assert.equal(JSON.stringify(result).includes(apiKey), false);
    assert.match(call.url, /gemini-3\.8-flash-lite-tts:generateContent$/);
    assert.equal(call.headers['x-goog-api-key'], apiKey);
    assert.deepEqual(call.body.generationConfig.responseModalities, ['AUDIO']);
    assert.equal(call.body.generationConfig.speechConfig.voiceConfig.voice, 'Kore');
    assert.equal(call.body.generationConfig.responseFormat.audio.mimeType, 'AUDIO_WAV');

    const invalid = await worker.fetch(request('/api/voice-preview', {
      method: 'POST', body: { voiceName: 'unknown-model' }
    }), env);
    assert.equal(invalid.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('creates one-use, short-lived Live tokens with the provider key kept server-side', async () => {
  const env = environment();
  const originalFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url: String(url), headers: options.headers, body: JSON.parse(options.body) };
    return Response.json({ name: 'authTokens/short-lived-test-token' });
  };
  try {
    const response = await worker.fetch(request('/api/live-token', {
      method: 'POST',
      body: {
        userName: 'Mira',
        memory: ['mag Astrofotografie'],
        context: [{ role: 'user', text: 'Wir planen einen Ausflug.' }, { role: 'assistant', text: 'Gern!' }]
      }
    }), env);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.token, 'authTokens/short-lived-test-token');
    assert.equal(data.model, 'models/gemini-3.8-live');
    assert.equal(data.config.generationConfig.responseModalities[0], 'AUDIO');
    assert.equal(JSON.stringify(data).includes(apiKey), false);
    assert.match(call.url, /\/v1beta\/auth_tokens$/);
    assert.equal(call.headers['x-goog-api-key'], apiKey);
    assert.equal(call.body.authToken.uses, 1);
    assert.equal(typeof call.body.authToken.newSessionExpireTime, 'string');
    assert.equal(call.body.authToken.bidiGenerateContentSetup.model, data.model);
    assert.equal(call.body.authToken.bidiGenerateContentSetup.generationConfig.responseModalities[0], 'AUDIO');
    assert.equal('liveConnectConstraints' in call.body, false);
    const instruction = data.config.systemInstruction.parts[0].text;
    assert.equal(data.model, 'models/gemini-3.8-live');
    assert.match(instruction, /Gespeicherter Name für die Anrede: "Mira"/);
    assert.match(instruction, /mag Astrofotografie/);
    assert.match(instruction, /Wir planen einen Ausflug/);

    const fallbackResponse = await worker.fetch(request('/api/live-token', { method: 'POST', body: { model: 'gemini-3.1-flash-live-preview', userName: 'Mira', voiceName: 'Puck' } }), env);
    assert.equal(fallbackResponse.status, 200);
    const fallback = await fallbackResponse.json();
    assert.equal(fallback.model, 'models/gemini-3.1-flash-live-preview');
    assert.deepEqual(data.config.tools[0], { googleSearch: {} });
    assert.equal(data.config.tools[1].functionDeclarations[0].name, 'show_web_preview');
    assert.equal([...env.SETTINGS.values.keys()].some(key => key.startsWith('guest:') && key.includes(':live:')), false);
    assert.equal([...env.SETTINGS.values.entries()].some(([key, value]) => key.startsWith('burst:live:') && value === '2'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ignores the legacy Live daily cap while retaining a short burst guard', async () => {
  const env = environment();
  const ip = '203.0.113.42';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip)));
  const client = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
  const day = new Date().toISOString().slice(0, 10);
  env.SETTINGS.values.set(`guest:${day}:live:${client}`, '24');
  const window = Math.floor(Date.now() / (10 * 60 * 1000));
  const burstKey = `burst:live:${window}:${client}`;
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls += 1; return Response.json({ name: 'authTokens/short-lived-test-token' }); };
  try {
    const allowed = await worker.fetch(request('/api/live-token', { method: 'POST', body: {} }), env);
    assert.equal(allowed.status, 200);
    assert.equal(env.SETTINGS.values.get(`guest:${day}:live:${client}`), '24');
    assert.equal(env.SETTINGS.values.get(burstKey), '1');

    env.SETTINGS.values.set(burstKey, '40');
    const throttled = await worker.fetch(request('/api/live-token', { method: 'POST', body: {} }), env);
    assert.equal(throttled.status, 429);
    assert.match((await throttled.json()).error, /kurzer Zeit/);
    assert.equal(providerCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fails closed when server secret is absent', async () => {
  const response = await worker.fetch(request('/api/chat', {
    method: 'POST', body: { messages: [{ role: 'user', text: 'test' }] }
  }), environment({ GEMINI_API_KEY: '' }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'Der Bard-Server ist noch nicht vollständig eingerichtet.');
});

