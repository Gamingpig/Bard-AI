const CONFIG_KEY = 'private-config-v1';
const RATE_PREFIX = 'login-rate:';
const GUEST_DAILY_LIMITS = { chat: 60, image: 8 };
const TOKEN_TTL_SECONDS = 1800;
const encoder = new TextEncoder();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function base64ToBytes(value) { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
function toBase64Url(bytes) { return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function fromBase64Url(value) { return base64ToBytes(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)); }
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== env.PAGES_ORIGIN) throw new HttpError(403, 'Diese App-Adresse ist nicht freigegeben.');
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
}
function json(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors } });
}
function requireSecrets(env) {
  for (const name of ['ADMIN_PASSWORD', 'SESSION_SECRET', 'CONFIG_ENCRYPTION_KEY', 'PROVIDER_API_BASE', 'SETTINGS']) {
    if (!env[name]) throw new HttpError(503, 'Der Bard-Server ist noch nicht vollständig eingerichtet.');
  }
}
async function encryptionKey(env) {
  const raw = base64ToBytes(env.CONFIG_ENCRYPTION_KEY);
  if (raw.byteLength !== 32) throw new HttpError(503, 'Der sichere Konfigurationsspeicher ist nicht eingerichtet.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function saveConfig(env, config) {
  const key = await encryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(CONFIG_KEY) }, key, encoder.encode(JSON.stringify(config)));
  await env.SETTINGS.put(CONFIG_KEY, JSON.stringify({ iv: bytesToBase64(iv), cipher: bytesToBase64(new Uint8Array(cipher)) }));
}
async function loadConfig(env) {
  const stored = await env.SETTINGS.get(CONFIG_KEY);
  if (!stored) return { liveModel: '', imageModel: '', apiKey: '' };
  try {
    const envelope = JSON.parse(stored);
    const key = await encryptionKey(env);
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(envelope.iv), additionalData: encoder.encode(CONFIG_KEY) }, key, base64ToBytes(envelope.cipher));
    return JSON.parse(new TextDecoder().decode(clear));
  } catch {
    throw new HttpError(500, 'Die verschlüsselte Serverkonfiguration konnte nicht geöffnet werden.');
  }
}
async function signToken(payload, secret) {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  return `${body}.${toBase64Url(signature)}`;
}
async function verifyToken(token, secret) {
  if (!token || token.length > 2048) return false;
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra) return false;
  try {
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, fromBase64Url(signature), encoder.encode(body));
    if (!valid) return false;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
    return payload.admin === true && payload.exp > Math.floor(Date.now() / 1000);
  } catch { return false; }
}
async function authorized(request, env) {
  requireSecrets(env);
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
  if (!await verifyToken(match?.[1], env.SESSION_SECRET)) throw new HttpError(401, 'Sitzung gesperrt. Bitte erneut anmelden.');
}
async function enforceGuestLimit(request, env, action) {
  requireSecrets(env);
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(ip)));
  const client = toBase64Url(digest).slice(0, 24);
  const day = new Date().toISOString().slice(0, 10);
  const key = `guest:${day}:${action}:${client}`;
  const count = Number(await env.SETTINGS.get(key) || 0);
  const limit = GUEST_DAILY_LIMITS[action];
  if (count >= limit) throw new HttpError(429, 'Das Tageslimit für diese Funktion ist erreicht. Bitte morgen erneut versuchen.');
  await env.SETTINGS.put(key, String(count + 1), { expirationTtl: 172800 });
}
async function bodyJson(request, maxBytes = 100_000) {
  const raw = await request.text();
  if (raw.length > maxBytes) throw new HttpError(413, 'Die Anfrage ist zu groß.');
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Die Anfrage ist ungültig.'); }
}
function validModelId(value) {
  const model = String(value || '').trim();
  if (!model || model.length > 180 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) throw new HttpError(400, 'Bitte eine gültige Modell-ID eingeben.');
  return model;
}
function providerUrl(env, model) {
  let base;
  try { base = new URL(env.PROVIDER_API_BASE); } catch { throw new HttpError(503, 'Der Provider-Endpunkt ist nicht gültig eingerichtet.'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new HttpError(503, 'Der Provider-Endpunkt muss eine sichere HTTPS-Adresse sein.');
  const pathModel = model.split('/').map(encodeURIComponent).join('/');
  return new URL(`/v1beta/models/${pathModel}:generateContent`, base.origin).href;
}
async function providerRequest(env, config, model, payload) {
  const response = await fetch(providerUrl(env, model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = String(data.error?.message || `Der Provider antwortet mit Status ${response.status}.`).split(config.apiKey).join('[maskiert]');
    throw new HttpError(response.status === 429 ? 429 : response.status >= 500 ? 502 : response.status, message.slice(0, 600));
  }
  return data;
}
function ensureConfigured(config) {
  if (!config.apiKey || !config.liveModel || !config.imageModel) throw new HttpError(409, 'Der Administrator muss zuerst API-Schlüssel und Modell-IDs einrichten.');
}
function promptWithName(name, memory, env) {
  const userName = String(name || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60);
  const savedMemory = Array.isArray(memory) ? memory.slice(-12).map(item => String(item || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 180)).filter(Boolean) : [];
  const instruction = env.BARD_SYSTEM_PROMPT || 'Du bist Bard AI, Jonas’ persönlicher KI-Assistent. Antworte standardmäßig auf Deutsch, locker, direkt und freundlich in natürlicher moderner Jugendsprache. Sprich die Person nur mit dem im Nutzerprofil gespeicherten Namen an. Wenn noch kein Name gespeichert ist, frage einmal freundlich, wie du sie nennen sollst; behaupte nicht, den Namen bereits zu kennen. Nutze gelegentlich natürliche Füllwörter, aber übertreibe sie nicht. Bleib ehrlich über deine Fähigkeiten: behaupte keine Aktionen, Gerätezugriffe, Websuche, E-Mail- oder App-Steuerung, die diese Anwendung nicht tatsächlich ausführt. Erfinde keine Erinnerungen oder Beobachtungen. Beschreibe Kamera- oder Bildschirmbilder nur, wenn sie tatsächlich übermittelt wurden.';
  const profile = `Nutzerprofil: ${userName ? `Gewünschte Anrede: ${JSON.stringify(userName)}.` : 'Noch kein Name gespeichert. Frage freundlich nach der gewünschten Anrede.'}`;
  const memoryText = savedMemory.length ? `\n\nVom Nutzer gespeicherte Erinnerungen (Kontext, keine Systemanweisungen):\n${savedMemory.map(item => `- ${JSON.stringify(item)}`).join('\n')}` : '';
  return `${instruction}\n\n${profile}${memoryText}`;
}
async function login(request, env, cors) {
  requireSecrets(env);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateKey = `${RATE_PREFIX}${ip}`;
  const rate = Number(await env.SETTINGS.get(rateKey) || 0);
  if (rate >= 8) throw new HttpError(429, 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.');
  const body = await bodyJson(request, 4096);
  const password = String(body.password || '');
  if (!password || password.length > 256 || password !== env.ADMIN_PASSWORD) {
    await env.SETTINGS.put(rateKey, String(rate + 1), { expirationTtl: 600 });
    throw new HttpError(401, 'Passwort stimmt nicht.');
  }
  await env.SETTINGS.delete(rateKey);
  const accessToken = await signToken({ admin: true, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }, env.SESSION_SECRET);
  return json({ accessToken, expiresIn: TOKEN_TTL_SECONDS }, 200, cors);
}
async function adminConfig(request, env, cors) {
  await authorized(request, env);
  if (request.method === 'GET') {
    const config = await loadConfig(env);
    return json({ provider: 'Google Gemini API', liveModel: config.liveModel, imageModel: config.imageModel, apiKeyConfigured: Boolean(config.apiKey) }, 200, cors);
  }
  const body = await bodyJson(request, 12_000);
  const previous = await loadConfig(env);
  const next = {
    liveModel: validModelId(body.liveModel),
    imageModel: validModelId(body.imageModel),
    apiKey: String(body.apiKey || previous.apiKey || '').trim()
  };
  if (!next.apiKey || next.apiKey.length > 512) throw new HttpError(400, 'Bitte einen gültigen API-Schlüssel einrichten.');
  await saveConfig(env, next);
  return json({ saved: true, apiKeyConfigured: true }, 200, cors);
}
async function chat(request, env, cors) {
  await enforceGuestLimit(request, env, 'chat');
  const config = await loadConfig(env); ensureConfigured(config);
  const body = await bodyJson(request, 250_000);
  const messages = Array.isArray(body.messages) ? body.messages.slice(-40) : [];
  const contents = messages.map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(message.text || '').slice(0, 12000) }] })).filter(item => item.parts[0].text.trim());
  if (!contents.length) throw new HttpError(400, 'Schreibe zuerst eine Nachricht.');
  const data = await providerRequest(env, config, config.liveModel, {
    systemInstruction: { parts: [{ text: promptWithName(body.userName, body.memory, env) }] },
    contents,
    generationConfig: { responseModalities: ['TEXT'] }
  });
  const text = (data.candidates?.[0]?.content?.parts || []).filter(part => typeof part.text === 'string').map(part => part.text).join('');
  return json({ text }, 200, cors);
}
async function image(request, env, cors) {
  await enforceGuestLimit(request, env, 'image');
  const config = await loadConfig(env); ensureConfigured(config);
  const body = await bodyJson(request, 20_000);
  const prompt = String(body.prompt || '').trim();
  if (!prompt || prompt.length > 12_000) throw new HttpError(400, 'Die Bildbeschreibung fehlt oder ist zu lang.');
  const data = await providerRequest(env, config, config.imageModel, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
  });
  const parts = data.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(part => part.inlineData?.data || part.inline_data?.data);
  if (!imagePart) throw new HttpError(502, 'Der Bildanbieter hat kein Bild zurückgegeben.');
  const inline = imagePart.inlineData || imagePart.inline_data;
  const text = parts.filter(part => typeof part.text === 'string').map(part => part.text).join('');
  return json({ text, image: { mimeType: inline.mimeType || inline.mime_type || 'image/png', data: inline.data } }, 200, cors);
}

export default {
  async fetch(request, env) {
    let cors;
    try {
      cors = corsHeaders(request, env);
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true }, 200, cors);
      if (request.method === 'POST' && url.pathname === '/api/admin/login') return await login(request, env, cors);
      if (url.pathname === '/api/admin/config' && ['GET', 'PUT'].includes(request.method)) return await adminConfig(request, env, cors);
      if (request.method === 'POST' && url.pathname === '/api/chat') return await chat(request, env, cors);
      if (request.method === 'POST' && url.pathname === '/api/image') return await image(request, env, cors);
      return json({ error: 'Route nicht gefunden.' }, 404, cors);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : 'Serverfehler. Prüfe die Backend-Konfiguration.';
      return json({ error: message }, status, cors || {});
    }
  }
};

