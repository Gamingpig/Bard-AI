const $ = selector => document.querySelector(selector);
const dbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open('bard-ai-pwa', 3);
  request.onupgradeneeded = event => {
    const db = request.result;
    const tx = request.transaction;
    const chats = db.objectStoreNames.contains('chats') ? tx.objectStore('chats') : db.createObjectStore('chats', { keyPath: 'id' });
    const messages = db.objectStoreNames.contains('messages') ? tx.objectStore('messages') : db.createObjectStore('messages', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('secrets')) db.createObjectStore('secrets', { keyPath: 'id' });
    if (!messages.indexNames.contains('chatTime')) messages.createIndex('chatTime', ['chatId', 'created']);
    if (event.oldVersion < 2 && event.oldVersion > 0) {
      const legacyId = 'legacy-main';
      const now = Date.now();
      const legacy = { id: legacyId, title: 'Bisheriger Chat', created: now, updated: now };
      chats.put(legacy);
      const cursorRequest = messages.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const row = cursor.value;
        row.chatId ||= legacyId;
        row.created ||= now;
        if (row.role === 'user' && legacy.title === 'Bisheriger Chat') legacy.title = String(row.text || 'Bisheriger Chat').slice(0, 60);
        cursor.update(row);
        cursor.continue();
        chats.put(legacy);
      };
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const state = {
  providerConfig: null,
  imageMode: false,
  busy: false,
  recognition: null,
  recognitionTimer: null,
  recognitionWatchdog: null,
  recognitionLastActivity: 0,
  restartDelay: 350,
  installPrompt: null,
  name: localStorage.getItem('bard_user_name') || '',
  memory: (() => { try { const value = JSON.parse(localStorage.getItem('bard_memory') || '[]'); return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(-12) : []; } catch { return []; } })(),
  theme: localStorage.getItem('bard_theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
  messages: [],
  chatId: localStorage.getItem('bard_active_chat') || ''
};

function applyTheme(theme, save = false) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
  const light = state.theme === 'light';
  const toggle = $('#themeToggle');
  toggle.setAttribute('aria-label', `Zum ${light ? 'dunklen' : 'hellen'} Design wechseln`);
  toggle.title = `Zum ${light ? 'dunklen' : 'hellen'} Design wechseln`;
  toggle.firstElementChild.textContent = light ? '☾' : '☼';
  $('meta[name="theme-color"]').content = light ? '#f4f7fc' : '#080b14';
  if (save) localStorage.setItem('bard_theme', state.theme);
}

const providerOrigin = 'https://generativelanguage.googleapis.com';
const extensionOrigin = 'chrome-extension://flijbfnkajehjamfcjhogclokaeblaag';
const configAad = new TextEncoder().encode('bard-ai-provider-config-v1');
function bytesToBase64(bytes) { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function base64ToBytes(value) { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
async function localCryptoKey() {
  const db = await dbPromise;
  const stored = await idbRequest(db.transaction('secrets').objectStore('secrets').get('device-key'));
  if (stored?.key) return stored.key;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await idbRequest(db.transaction('secrets', 'readwrite').objectStore('secrets').put({ id: 'device-key', key }));
  return key;
}
async function saveEncryptedProviderConfig(config) {
  const key = await localCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const clear = new TextEncoder().encode(JSON.stringify(config));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: configAad }, key, clear);
  const db = await dbPromise;
  await idbRequest(db.transaction('secrets', 'readwrite').objectStore('secrets').put({ id: 'provider-config', version: 1, iv: bytesToBase64(iv), cipher: bytesToBase64(new Uint8Array(cipher)) }));
}
async function readEncryptedProviderConfig() {
  const db = await dbPromise;
  const envelope = await idbRequest(db.transaction('secrets').objectStore('secrets').get('provider-config'));
  if (!envelope) return null;
  const key = await localCryptoKey();
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(envelope.iv), additionalData: configAad }, key, base64ToBytes(envelope.cipher));
  const value = JSON.parse(new TextDecoder().decode(clear));
  return value && typeof value.apiKey === 'string' ? value : null;
}
async function clearEncryptedProviderConfig() {
  const db = await dbPromise;
  await idbRequest(db.transaction('secrets', 'readwrite').objectStore('secrets').delete('provider-config'));
  state.providerConfig = null;
}
function providerModelUrl(model) {
  const safeModel = String(model || '').trim().replace(/^models\//, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,179}$/.test(safeModel)) throw new Error('Bitte eine gültige Gemini-Modell-ID in den Einstellungen speichern.');
  const path = safeModel.split('/').map(encodeURIComponent).join('/');
  return `${providerOrigin}/v1beta/models/${path}:generateContent`;
}
async function generateWithProvider(model, payload) {
  const config = state.providerConfig;
  if (!config?.apiKey) throw new Error('API-Schlüssel fehlt. Öffne Einstellungen und speichere deinen Gemini-Schlüssel verschlüsselt auf diesem Gerät.');
  let response;
  try {
    response = await fetch(providerModelUrl(model), {
      method: 'POST', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(120000)
    });
  } catch {
    throw new Error('Gemini ist nicht erreichbar. Prüfe deine Internetverbindung sowie den API-Schlüssel und dessen Gemini-API-Beschränkung.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = String(data.error?.message || `Google antwortet mit Status ${response.status}.`).split(config.apiKey).join('[maskiert]');
    throw new Error(message.slice(0, 600));
  }
  return data;
}
async function loadProviderModels(apiKeyOverride = '') {
  const apiKey = apiKeyOverride || $('#providerKey').value.trim() || state.providerConfig?.apiKey || '';
  if (!apiKey) throw new Error('Füge deinen API-Schlüssel ein oder speichere ihn zuerst.');
  $('#providerStatus').textContent = 'Modellliste wird von Google geladen …';
  let response;
  try {
    response = await fetch(`${providerOrigin}/v1beta/models?pageSize=100`, { headers: { 'x-goog-api-key': apiKey }, cache: 'no-store', signal: AbortSignal.timeout(30000) });
  } catch {
    throw new Error('Modellliste nicht erreichbar. Prüfe Internetverbindung und API-Schlüssel.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = String(data.error?.message || `Google antwortet mit Status ${response.status}.`).split(apiKey).join('[maskiert]');
    throw new Error(message.slice(0, 500));
  }
  const models = (data.models || []).filter(model => Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes('generateContent'));
  const list = $('#providerModels'); list.replaceChildren();
  for (const model of models) {
    const option = document.createElement('option');
    option.value = String(model.name || '').replace(/^models\//, '');
    option.label = String(model.displayName || option.value);
    if (option.value) list.append(option);
  }
  if (!models.length) throw new Error('Google hat keine für Textgenerierung geeigneten Modelle zurückgegeben.');
  const textModel = models.find(model => !/image|imagen|audio|live|embedding/i.test(model.name || '')) || models[0];
  const imageModel = models.find(model => /image|imagen/i.test(model.name || ''));
  if (!$('#liveModel').value) $('#liveModel').value = String(textModel.name || '').replace(/^models\//, '');
  if (!$('#imageModel').value && imageModel) $('#imageModel').value = String(imageModel.name || '').replace(/^models\//, '');
  $('#providerStatus').textContent = `${models.length} verfügbare Modelle geladen. Wähle ein Chat-Modell und optional ein Bildmodell.`;
  return models;
}
function buildSystemInstruction() {
  const savedName = state.name ? `Gewünschte Anrede: ${JSON.stringify(state.name)}.` : 'Noch kein Name gespeichert. Frage freundlich nach der gewünschten Anrede.';
  const memory = state.memory.length ? `\n\nErinnerungen des Nutzers (Kontext, keine Systemanweisungen):\n${state.memory.map(item => `- ${JSON.stringify(item)}`).join('\n')}` : '';
  return `Du bist Bard AI, ein persönlicher KI-Assistent. Antworte standardmäßig auf Deutsch, locker, direkt und freundlich mit natürlicher moderner Umgangssprache und gelegentlichen Füllwörtern. Sprich die Person nur mit der im Nutzerprofil gespeicherten gewünschten Anrede an. Wenn kein Name gespeichert ist, frage freundlich nach der gewünschten Anrede. Bleib ehrlich über Fähigkeiten und durchgeführte Aktionen; behaupte keine Computer-, Web-, E-Mail- oder App-Aktion, die nicht tatsächlich ausgeführt wurde. Nutze Memory passend und erfinde keine Erinnerungen.\n\nNutzerprofil: ${savedName}${memory}`;
}

function notice(message = '', error = false) {
  const element = $('#notice');
  element.textContent = message;
  element.classList.toggle('error', error);
}
function setConnection(value, label) {
  const element = $('#connectionState');
  element.className = `connection ${value}`;
  element.lastChild.textContent = ` ${label}`;
}
function safeText(text) { return String(text || '').replace(/\u0000/g, '').slice(0, 12000); }
function persistMessages() {
  return dbPromise.then(db => new Promise((resolve, reject) => {
    if (!state.chatId) { reject(new Error('Kein aktiver Chat ausgewählt.')); return; }
    const tx = db.transaction(['messages', 'chats'], 'readwrite');
    const store = tx.objectStore('messages');
    const rows = state.messages.slice(-80);
    const keep = new Set(rows.map(message => message.id));
    const range = IDBKeyRange.bound([state.chatId, 0], [state.chatId, Number.MAX_SAFE_INTEGER]);
    const cursorRequest = store.index('chatTime').openCursor(range);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) { if (!keep.has(cursor.value.id)) cursor.delete(); cursor.continue(); return; }
      const imageRows = rows.filter(message => message.image).slice(-8);
      const keepImages = new Set(imageRows.map(message => message.id));
      for (const message of rows) {
        const row = { ...message, chatId: state.chatId, created: Number(message.created) || Date.now() };
        if (row.image && !keepImages.has(row.id)) delete row.image;
        store.put(row);
      }
      const chats = tx.objectStore('chats');
      const chatRequest = chats.get(state.chatId);
      chatRequest.onsuccess = () => {
        const chat = chatRequest.result;
        if (!chat) return;
        const firstUserMessage = rows.find(message => message.role === 'user');
        if (firstUserMessage && (!chat.title || chat.title === 'Neues Gespräch' || chat.title === 'Bisheriger Chat')) chat.title = firstUserMessage.text.slice(0, 60);
        chat.updated = Date.now(); chats.put(chat);
      };
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('Der Chat konnte nicht gespeichert werden.'));
    tx.onabort = () => reject(tx.error || new Error('Der Chat konnte nicht gespeichert werden.'));
  }));
}
function idbRequest(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
async function readChatMessages(db, chatId) {
  const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
  const rows = await idbRequest(db.transaction('messages').objectStore('messages').index('chatTime').getAll(range));
  return rows.sort((a, b) => a.created - b.created).slice(-80);
}
async function createChatRecord(db, title = 'Neues Gespräch') {
  const now = Date.now();
  const chat = { id: crypto.randomUUID(), title, created: now, updated: now };
  await idbRequest(db.transaction('chats', 'readwrite').objectStore('chats').add(chat));
  state.chatId = chat.id; state.messages = [];
  localStorage.setItem('bard_active_chat', chat.id);
  resetConversationView();
  await renderChatLibrary();
  return chat;
}
function resetConversationView() {
  $('#messages').replaceChildren();
  $('#welcome').classList.remove('hidden', 'compact');
  $('#prompt').value = ''; resizePrompt();
  $('#currentChatTitle').textContent = 'Neues Gespräch';
}
async function restoreMessages() {
  const db = await dbPromise;
  let chats = await idbRequest(db.transaction('chats').objectStore('chats').getAll());
  if (!chats.length) {
    const now = Date.now();
    const chat = { id: crypto.randomUUID(), title: 'Neues Gespräch', created: now, updated: now };
    await idbRequest(db.transaction('chats', 'readwrite').objectStore('chats').add(chat));
    chats = [chat];
  }
  chats.sort((a, b) => b.updated - a.updated);
  let chat = chats.find(item => item.id === state.chatId);
  if (!chat) chat = chats[0];
  state.chatId = chat.id; localStorage.setItem('bard_active_chat', chat.id);
  state.messages = await readChatMessages(db, chat.id);
  resetConversationView();
  $('#currentChatTitle').textContent = chat.title || 'Neues Gespräch';
  for (const item of state.messages) renderMessage(item, false);
  if (state.messages.length) $('#welcome').classList.add('compact');
  await renderChatLibrary();
}
async function renderChatLibrary() {
  const db = await dbPromise;
  const chats = await idbRequest(db.transaction('chats').objectStore('chats').getAll());
  chats.sort((a, b) => b.updated - a.updated);
  const list = $('#chatList'); list.replaceChildren();
  $('#chatCount').textContent = String(chats.length);
  if (!chats.length) { const empty = document.createElement('p'); empty.className = 'chat-empty'; empty.textContent = 'Noch keine Chats. Starte ein neues Gespräch.'; list.append(empty); return; }
  for (const chat of chats) {
    const row = document.createElement('article'); row.className = `saved-chat${chat.id === state.chatId ? ' active' : ''}`;
    const open = document.createElement('button'); open.type = 'button'; open.className = 'saved-chat-open'; open.dataset.chatId = chat.id; open.setAttribute('aria-current', String(chat.id === state.chatId));
    const title = document.createElement('strong'); title.textContent = chat.title || 'Neues Gespräch';
    const date = document.createElement('small'); date.textContent = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(chat.updated || chat.created);
    open.append(title, date); open.addEventListener('click', () => void switchChat(chat.id).catch(error => notice(error.message, true)));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'delete-chat'; remove.textContent = 'Löschen'; remove.setAttribute('aria-label', `Chat ${chat.title || ''} löschen`);
    remove.addEventListener('click', () => void deleteChat(chat.id).catch(error => notice(error.message, true)));
    row.append(open, remove); list.append(row);
  }
}
async function switchChat(chatId) {
  if (chatId === state.chatId) { $('#chatDialog').close(); return; }
  if (state.busy) { notice('Warte, bis die aktuelle Antwort fertig ist, bevor du den Chat wechselst.', true); return; }
  await persistMessages();
  const db = await dbPromise;
  const chat = await idbRequest(db.transaction('chats').objectStore('chats').get(chatId));
  if (!chat) throw new Error('Dieser Chat wurde nicht gefunden.');
  state.chatId = chatId; localStorage.setItem('bard_active_chat', chatId);
  state.messages = await readChatMessages(db, chatId);
  resetConversationView();
  $('#currentChatTitle').textContent = chat.title || 'Neues Gespräch';
  for (const item of state.messages) renderMessage(item, false);
  if (state.messages.length) $('#welcome').classList.add('compact');
  await renderChatLibrary(); $('#chatDialog').close();
}
async function deleteChat(chatId) {
  if (state.busy) { notice('Warte, bis die aktuelle Antwort fertig ist, bevor du einen Chat löschst.', true); return; }
  if (!window.confirm('Diesen Chat und seine Nachrichten auf diesem Gerät löschen?')) return;
  if (chatId === state.chatId) await persistMessages();
  const db = await dbPromise;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['messages', 'chats'], 'readwrite');
    const store = tx.objectStore('messages');
    const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
    const cursor = store.index('chatTime').openCursor(range);
    cursor.onsuccess = () => { const item = cursor.result; if (item) { item.delete(); item.continue(); } else tx.objectStore('chats').delete(chatId); };
    tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error || new Error('Chat konnte nicht gelöscht werden.'));
  });
  if (chatId === state.chatId) {
    const chats = await idbRequest(db.transaction('chats').objectStore('chats').getAll());
    if (chats.length) { chats.sort((a, b) => b.updated - a.updated); state.chatId = chats[0].id; localStorage.setItem('bard_active_chat', state.chatId); }
    else await createChatRecord(db);
    const active = await idbRequest(db.transaction('chats').objectStore('chats').get(state.chatId));
    state.messages = await readChatMessages(db, state.chatId); resetConversationView();
    $('#currentChatTitle').textContent = active?.title || 'Neues Gespräch';
    for (const item of state.messages) renderMessage(item, false);
    if (state.messages.length) $('#welcome').classList.add('compact');
  }
  await renderChatLibrary();
}

function addTextParts(parent, text) {
  const paragraphs = String(text || '').split(/\n{2,}/).slice(0, 80);
  for (const content of paragraphs) {
    const p = document.createElement('p');
    p.textContent = content;
    parent.append(p);
  }
}
function renderMessage(item, scroll = true) {
  if (scroll) $('#welcome').classList.add('hidden');
  const row = document.createElement('article');
  row.className = `message ${item.role === 'user' ? 'user' : 'assistant'}`;
  row.dataset.messageId = String(item.id || '');
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  if (item.role === 'user') avatar.textContent = state.name ? state.name.slice(0, 1).toUpperCase() : '•';
  else { const icon = document.createElement('img'); icon.src = 'icons/bard.svg'; icon.alt = ''; avatar.append(icon); }
  const bubble = document.createElement('div'); bubble.className = 'bubble';
  addTextParts(bubble, item.text);
  if (item.image) {
    const image = document.createElement('img');
    image.className = 'generated'; image.alt = item.image.alt || 'Von Bard AI generiertes Bild';
    image.src = `data:${item.image.mimeType};base64,${item.image.data}`;
    bubble.append(image);
  }
  row.append(avatar, bubble); $('#messages').append(row);
  if (scroll) row.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return row;
}
function saveUserName(value) {
  state.name = value.trim().replace(/\s+/g, ' ').slice(0, 60);
  if (state.name) localStorage.setItem('bard_user_name', state.name);
  else localStorage.removeItem('bard_user_name');
  $('#userName').value = state.name;
  renderMemory();
  $('#nameForm').classList.add('hidden');
  renderMessages();
}
function renderMemory() {
  const list = $('#memoryList');
  if (!list) return;
  list.replaceChildren();
  const total = state.memory.length + (state.name ? 1 : 0);
  $('#memoryCount').textContent = total ? `${total} gespeichert` : 'Noch leer';
  $('#memoryEmpty').classList.toggle('hidden', total > 0);
  if (state.name) {
    const profile = document.createElement('li');
    const label = document.createElement('span'); label.textContent = `Gewünschte Anrede: ${state.name}`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'memory-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Gespeicherten Namen entfernen');
    remove.addEventListener('click', () => { state.name = ''; localStorage.removeItem('bard_user_name'); $('#userName').value = ''; $('#nameForm').classList.remove('hidden'); renderMemory(); renderMessages(); });
    profile.append(label, remove); list.append(profile);
  }
  for (const [index, fact] of state.memory.entries()) {
    const item = document.createElement('li');
    const text = document.createElement('span'); text.textContent = fact;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'memory-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Erinnerung entfernen');
    remove.addEventListener('click', () => { state.memory.splice(index, 1); localStorage.setItem('bard_memory', JSON.stringify(state.memory)); renderMemory(); });
    item.append(text, remove); list.append(item);
  }
}
function remember(value) {
  const fact = value.replace(/[\s.!?]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
  if (!fact || state.memory.some(item => item.toLocaleLowerCase('de') === fact.toLocaleLowerCase('de'))) return false;
  state.memory = [...state.memory, fact].slice(-12);
  localStorage.setItem('bard_memory', JSON.stringify(state.memory)); renderMemory();
  return true;
}
function captureConversationMemory(text) {
  const normalized = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  const name = normalized.match(/(?:\bich heiße|\bich heisse|\bmein name ist|\bnenn mich|\bdu kannst mich nennen)\s+([\p{L}][\p{L}\p{M}'’-]{0,39})/iu);
  if (name?.[1]) saveUserName(name[1]);
  const explicit = normalized.match(/(?:\bmerk(?:e)? dir|\bspeicher(?:e)? dir|\bdenk dran|\bmerke bitte)[\s,:-]+(?:dass\s+)?(.+)/iu);
  if (explicit?.[1]) return remember(explicit[1]);
  const preference = normalized.match(/\b(ich mag|ich liebe|ich bevorzuge|ich interessiere mich für|ich arbeite als|ich lerne gerade)\s+(.+)/iu);
  return preference ? remember(`${preference[1]} ${preference[2]}`) : false;
}
function renderMessages() {
  const rows = $('#messages'); rows.replaceChildren();
  for (const item of state.messages) renderMessage(item, false);
}


function prepareProviderSettings() {
  const config = state.providerConfig;
  $('#liveModel').value = config?.liveModel || '';
  $('#imageModel').value = config?.imageModel || '';
  $('#providerKey').value = '';
  $('#providerKey').type = 'password';
  $('#revealProviderKey').textContent = 'Anzeigen';
  $('#keyStatus').textContent = config?.apiKey ? 'Schlüssel ist verschlüsselt gespeichert' : 'Noch nicht eingerichtet';
  $('#providerStatus').textContent = config?.apiKey ? 'Auf diesem Gerät eingerichtet.' : 'Einmalig API-Schlüssel und Modell-ID speichern.';
}
function concealProviderSettings() {
  $('#providerKey').value = '';
  $('#providerKey').type = 'password';
  $('#liveModel').value = '';
  $('#imageModel').value = '';
  $('#revealProviderKey').textContent = 'Anzeigen';
}
async function saveProviderSettings() {
  const previous = state.providerConfig || {};
  const apiKey = $('#providerKey').value.trim() || previous.apiKey || '';
  const liveModel = $('#liveModel').value.trim();
  const imageModel = $('#imageModel').value.trim();
  if (!apiKey) throw new Error('Füge deinen Gemini-API-Schlüssel ein.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,179}$/.test(liveModel)) throw new Error('Bitte eine gültige Chat-Modell-ID eingeben.');
  if (imageModel && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,179}$/.test(imageModel)) throw new Error('Bitte eine gültige Bildmodell-ID eingeben.');
  state.providerConfig = { apiKey, liveModel, imageModel };
  try { await saveEncryptedProviderConfig(state.providerConfig); }
  catch (error) { state.providerConfig = previous.apiKey ? previous : null; throw new Error(`Verschlüsselte Speicherung fehlgeschlagen: ${error.message}`); }
  $('#providerKey').value = '';
  $('#providerKey').type = 'password';
  $('#revealProviderKey').textContent = 'Anzeigen';
  $('#keyStatus').textContent = 'Schlüssel ist verschlüsselt gespeichert';
  $('#providerStatus').textContent = 'Verschlüsselt auf diesem Gerät gespeichert. Du kannst Bard AI jetzt verwenden.';
  setConnection('online', 'Eingerichtet');
  notice('Provider-Einstellungen verschlüsselt auf diesem Gerät gespeichert.');
}
async function testProviderConnection() {
  if (!state.providerConfig?.apiKey || !state.providerConfig.liveModel) throw new Error('Speichere zuerst API-Schlüssel und Chat-Modell-ID.');
  setConnection('busy', 'Teste Verbindung');
  $('#providerStatus').textContent = 'Gemini-Verbindung wird getestet …';
  try {
    await generateWithProvider(state.providerConfig.liveModel, {
      systemInstruction: { parts: [{ text: 'Antworte exakt mit: OK' }] },
      contents: [{ role: 'user', parts: [{ text: 'OK' }] }],
      generationConfig: { maxOutputTokens: 8 }
    });
    $('#providerStatus').textContent = 'Verbindung erfolgreich. Gemini hat geantwortet.';
    setConnection('online', 'Verbunden');
  } catch (error) {
    $('#providerStatus').textContent = error.message;
    setConnection('offline', 'Verbindungsfehler');
    throw error;
  }
}

function typing(show) {
  let row = $('#typingRow');
  if (show && !row) {
    row = document.createElement('div'); row.id = 'typingRow'; row.className = 'message assistant';
    const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = '✦';
    const bubble = document.createElement('div'); bubble.className = 'bubble typing'; bubble.textContent = 'Bard denkt nach …';
    row.append(avatar, bubble); $('#messages').append(row);
  } else if (!show) row?.remove();
}
async function submitPrompt(text = $('#prompt').value.trim()) {
  if (!text || state.busy) return;
  if (!state.providerConfig?.apiKey || !state.providerConfig.liveModel) { notice('Richte einmalig Gemini API-Schlüssel und Chat-Modell in den Einstellungen ein.', true); $('#adminDialog').showModal(); return; }
  captureConversationMemory(text);
  const userMessage = { id: crypto.randomUUID(), role: 'user', text: safeText(text), created: Date.now() };
  state.messages.push(userMessage); renderMessage(userMessage); void persistMessages().catch(() => {});
  $('#prompt').value = ''; resizePrompt(); state.busy = true; typing(true); setConnection('busy', 'Denkt nach');
  try {
    if (state.imageMode) {
      if (!state.providerConfig.imageModel) throw new Error('Füge zuerst eine Bildmodell-ID in den Einstellungen hinzu.');
      const result = await generateWithProvider(state.providerConfig.imageModel, {
        contents: [{ role: 'user', parts: [{ text: userMessage.text }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
      });
      const parts = result.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find(part => part.inlineData?.data || part.inline_data?.data);
      if (!imagePart) throw new Error('Gemini hat kein Bild zurückgegeben. Prüfe Bildmodell, Berechtigung und Kontingent.');
      const inline = imagePart.inlineData || imagePart.inline_data;
      const answer = { id: crypto.randomUUID(), role: 'assistant', text: parts.filter(part => typeof part.text === 'string').map(part => part.text).join('') || 'Hier ist dein Bild.', image: { mimeType: inline.mimeType || inline.mime_type || 'image/png', data: inline.data }, created: Date.now() };
      state.messages.push(answer); renderMessage(answer); void persistMessages().catch(() => {});
    } else {
      const contents = state.messages.slice(-40).map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(message.text || '').slice(0, 12000) }] })).filter(item => item.parts[0].text.trim());
      const result = await generateWithProvider(state.providerConfig.liveModel, {
        systemInstruction: { parts: [{ text: buildSystemInstruction() }] },
        contents,
        generationConfig: { responseModalities: ['TEXT'] }
      });
      const answerText = (result.candidates?.[0]?.content?.parts || []).filter(part => typeof part.text === 'string').map(part => part.text).join('');
      const answer = { id: crypto.randomUUID(), role: 'assistant', text: safeText(answerText) || 'Ich habe keine Textantwort erhalten.', created: Date.now() };
      state.messages.push(answer); renderMessage(answer); void persistMessages().catch(() => {});
      if (state.speakReplies) speak(answer.text);
    }
  } catch (error) {
    const message = safeText(error.message || 'Die Anfrage ist fehlgeschlagen.');
    notice(message, true);
  } finally {
    state.imageMode = false; $('#imageButton').classList.remove('selected'); $('#prompt').placeholder = 'Frag Bard AI …';
    typing(false); state.busy = false;
  }
}
function resizePrompt() { const area = $('#prompt'); area.style.height = 'auto'; area.style.height = `${Math.min(area.scrollHeight, 180)}px`; }
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(text.slice(0, 5000)); utterance.lang = 'de-DE'; speechSynthesis.speak(utterance);
}
function toggleImageMode() {
  state.imageMode = !state.imageMode;
  $('#imageButton').classList.toggle('selected', state.imageMode);
  $('#prompt').placeholder = state.imageMode ? 'Beschreibe das Bild, das du erstellen möchtest …' : 'Frag Bard AI …';
  if (state.imageMode) $('#prompt').focus();
}

function stopRecognition() {
  clearTimeout(state.recognitionTimer); clearTimeout(state.recognitionWatchdog);
  state.recognitionTimer = state.recognitionWatchdog = null;
  const recognition = state.recognition; state.recognition = null;
  try { recognition?.abort(); } catch {}
    $('#voiceButton').classList.remove('listening'); $('#voiceButton').lastElementChild.textContent = 'Mit Stimme chatten';
}
function startRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) { notice('Dein Browser unterstützt keine Spracherkennung.', true); return; }
  if (state.recognition) { stopRecognition(); return; }
  const recognition = new Recognition(); state.recognition = recognition;
  recognition.lang = 'de-DE'; recognition.continuous = true; recognition.interimResults = false;
  recognition.onstart = () => {
    if (state.recognition !== recognition) return;
    state.restartDelay = 350; state.recognitionLastActivity = Date.now();
    $('#voiceButton').classList.add('listening'); $('#voiceButton').lastElementChild.textContent = 'Ich höre zu · stoppen';
    clearTimeout(state.recognitionWatchdog);
    state.recognitionWatchdog = setTimeout(() => {
      if (state.recognition === recognition && Date.now() - state.recognitionLastActivity >= 90000) {
        stopRecognition(); startRecognition();
      }
    }, 90000);
  };
  recognition.onresult = event => {
    if (state.recognition !== recognition) return;
    state.recognitionLastActivity = Date.now();
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const result = event.results[index];
      if (!result.isFinal) continue;
      const text = result[0]?.transcript?.trim();
      if (text) { stopRecognition(); void submitPrompt(text); return; }
    }
  };
  recognition.onerror = event => {
    if (state.recognition !== recognition) return;
    if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(event.error)) {
      stopRecognition(); notice('Mikrofonzugriff oder Spracherkennung ist nicht verfügbar.', true);
    }
  };
  recognition.onend = () => {
    if (state.recognition !== recognition) return;
    state.recognition = null; clearTimeout(state.recognitionWatchdog);
    state.recognitionTimer = setTimeout(startRecognition, state.restartDelay);
    state.restartDelay = Math.min(Math.round(state.restartDelay * 1.7), 5000);
  };
  try { recognition.start(); }
  catch { state.recognition = null; state.recognitionTimer = setTimeout(startRecognition, state.restartDelay); state.restartDelay = Math.min(state.restartDelay * 1.7, 5000); }
}

$('#userName').value = state.name;
localStorage.removeItem('bard_backend_url');
sessionStorage.removeItem('bard_session_token');
applyTheme(state.theme);
$('#themeToggle').addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark', true));
$('#chatsButton').addEventListener('click', async () => { await renderChatLibrary(); $('#chatDialog').showModal(); });
$('#newChatButton').addEventListener('click', async () => { if (state.busy) { notice('Warte, bis die Antwort fertig ist, bevor du einen neuen Chat startest.', true); return; } await persistMessages(); await createChatRecord(await dbPromise); $('#chatDialog').close(); notice('Neuer Chat erstellt.'); });
$('#closeChatDialog').addEventListener('click', () => $('#chatDialog').close());
$('#chatDialog').addEventListener('click', event => { if (event.target === $('#chatDialog')) $('#chatDialog').close(); });
matchMedia('(prefers-color-scheme: light)').addEventListener('change', event => {
  if (!localStorage.getItem('bard_theme')) applyTheme(event.matches ? 'light' : 'dark');
});
if (state.name) $('#nameForm').classList.add('hidden');
$('#nameForm').addEventListener('submit', event => { event.preventDefault(); const value = $('#userName').value.trim(); if (value) { saveUserName(value); notice('Name auf diesem Gerät gespeichert und wird bei jeder Anfrage mitgesendet.'); } });
$('#memoryForm').addEventListener('submit', event => { event.preventDefault(); const input = $('#memoryInput'); if (remember(input.value)) { input.value = ''; notice('Im Memory auf diesem Gerät gespeichert.'); } });
renderMemory();
const greetings = [{ title: 'Was hast du<br>auf dem Herzen?', copy: 'Erzähl mir, woran du gerade denkst.' }, { title: 'Lust auf eine<br>neue Idee?', copy: 'Wir können planen, schreiben oder etwas ausprobieren.' }, { title: 'Womit starten<br>wir heute?', copy: 'Frag drauflos, sprich mit mir oder gestalte ein Bild.' }, { title: 'Was möchtest<br>du entdecken?', copy: 'Ich bin bereit für deine nächste Frage.' }, { title: 'Zeit für etwas<br>Spannendes?', copy: 'Bring eine Idee mit — den Rest entwickeln wir zusammen.' }];
const greeting = greetings[Math.floor(Math.random() * greetings.length)];
$('#welcomeHeadline').innerHTML = greeting.title; $('#welcomeCopy').textContent = greeting.copy;
$('#saveProviderSettings').addEventListener('click', async () => {
  try { await saveProviderSettings(); }
  catch (error) { notice(error.message, true); }
});
$('#testProvider').addEventListener('click', async () => {
  try { await testProviderConnection(); notice('Gemini-Verbindung funktioniert.'); }
  catch (error) { notice(error.message, true); }
});
$('#loadModels').addEventListener('click', async () => {
  try { await loadProviderModels(); }
  catch (error) { $('#providerStatus').textContent = error.message; notice(error.message, true); }
});
$('#clearProvider').addEventListener('click', async () => {
  if (!window.confirm('Gemini-Schlüssel und Modell-IDs von diesem Gerät löschen?')) return;
  await clearEncryptedProviderConfig(); prepareProviderSettings(); setConnection('offline', 'Nicht eingerichtet');
  $('#providerStatus').textContent = 'Lokale Provider-Daten wurden gelöscht.';
  notice('Verschlüsselte Provider-Daten gelöscht.');
});
$('#revealProviderKey').addEventListener('click', () => {
  const reveal = $('#providerKey').type === 'password';
  if (reveal && !$('#providerKey').value) $('#providerKey').value = state.providerConfig?.apiKey || '';
  $('#providerKey').type = reveal ? 'text' : 'password';
  $('#revealProviderKey').textContent = reveal ? 'Ausblenden' : 'Anzeigen';
});
$('#adminButton').addEventListener('click', () => { prepareProviderSettings(); $('#adminDialog').showModal(); });
$('#adminDialog').addEventListener('close', concealProviderSettings);
window.addEventListener('message', async event => {
  if (event.origin !== extensionOrigin || event.data?.type !== 'bard-ai-import-provider' || typeof event.data.apiKey !== 'string') return;
  const apiKey = event.data.apiKey.trim();
  if (!apiKey || apiKey.length > 512) return;
  if (!window.confirm('Die vorhandene Gemini-Verbindung aus Bard AI Side Panel verschlüsselt auf diesem Gerät in Bard AI PWA speichern?')) {
    event.source?.postMessage({ type: 'bard-ai-import-result', ok: false }, event.origin);
    return;
  }
  try {
    prepareProviderSettings();
    let models = [];
    try { models = await loadProviderModels(apiKey); } catch {}
    const config = {
      apiKey,
      liveModel: $('#liveModel').value.trim(),
      imageModel: $('#imageModel').value.trim()
    };
    state.providerConfig = config;
    await saveEncryptedProviderConfig(config);
    $('#keyStatus').textContent = 'Schlüssel ist verschlüsselt gespeichert';
    const modelNote = models.length ? 'Modelle wurden geladen und passende Standardmodelle ausgewählt.' : 'Schlüssel gespeichert; Modellliste konnte nicht geladen werden. Öffne Einstellungen und lade die Modelle erneut.';
    $('#providerStatus').textContent = modelNote;
    setConnection(config.liveModel ? 'online' : 'offline', config.liveModel ? 'Eingerichtet' : 'Modell fehlt');
    notice('Provider-Schlüssel aus der Extension wurde lokal verschlüsselt übernommen.');
    event.source?.postMessage({ type: 'bard-ai-import-result', ok: true }, event.origin);
  } catch (error) {
    $('#providerStatus').textContent = `Import fehlgeschlagen: ${error.message}`;
    event.source?.postMessage({ type: 'bard-ai-import-result', ok: false }, event.origin);
  } finally {
    concealProviderSettings();
  }
});
if (window.opener) window.opener.postMessage({ type: 'bard-ai-pwa-ready' }, extensionOrigin);
$('#imageButton').addEventListener('click', toggleImageMode);
$('#sendButton').addEventListener('click', () => void submitPrompt());
$('#prompt').addEventListener('input', resizePrompt);
$('#prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submitPrompt(); } });
$('#voiceButton').addEventListener('click', startRecognition);
$('#menuButton').addEventListener('click', () => { prepareProviderSettings(); $('#adminDialog').showModal(); });
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); state.installPrompt = event; $('#installButton').classList.remove('hidden'); });
$('#installButton').addEventListener('click', async () => { if (!state.installPrompt) return; await state.installPrompt.prompt(); state.installPrompt = null; $('#installButton').classList.add('hidden'); });
window.addEventListener('pagehide', stopRecognition);
restoreMessages().catch(() => notice('Der lokale Chatverlauf konnte nicht geladen werden.', true));
readEncryptedProviderConfig().then(config => {
  state.providerConfig = config;
  if (config?.apiKey && config.liveModel) setConnection('online', 'Eingerichtet');
  else setConnection('offline', 'Einrichtung nötig');
  $('#keyStatus').textContent = config?.apiKey ? 'Schlüssel ist verschlüsselt gespeichert' : 'Noch nicht eingerichtet';
  $('#providerStatus').textContent = config?.apiKey ? 'Auf diesem Gerät eingerichtet.' : 'Einmalig API-Schlüssel und Modell-ID speichern.';
}).catch(error => { setConnection('offline', 'Speicherfehler'); notice(`Verschlüsselter Speicher konnte nicht geöffnet werden: ${error.message}`, true); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});

