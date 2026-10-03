const $ = selector => document.querySelector(selector);
const LIVE_VOICES = [
  { name: 'Zephyr', style: 'Hell' },
  { name: 'Puck', style: 'Lebhaft' },
  { name: 'Charon', style: 'Informativ' },
  { name: 'Kore', style: 'Bestimmt' },
  { name: 'Fenrir', style: 'Energiegeladen' },
  { name: 'Leda', style: 'Jugendlich' },
  { name: 'Orus', style: 'Bestimmt' },
  { name: 'Aoede', style: 'Locker' },
  { name: 'Callirrhoe', style: 'Entspannt' },
  { name: 'Autonoe', style: 'Hell' },
  { name: 'Enceladus', style: 'Sanft' },
  { name: 'Iapetus', style: 'Klar' },
  { name: 'Umbriel', style: 'Entspannt' },
  { name: 'Algieba', style: 'Sanft' },
  { name: 'Despina', style: 'Sanft' },
  { name: 'Erinome', style: 'Klar' },
  { name: 'Algenib', style: 'Rau' },
  { name: 'Rasalgethi', style: 'Informativ' },
  { name: 'Laomedeia', style: 'Lebhaft' },
  { name: 'Achernar', style: 'Weich' },
  { name: 'Alnilam', style: 'Bestimmt' },
  { name: 'Schedar', style: 'Ausgeglichen' },
  { name: 'Gacrux', style: 'Reif' },
  { name: 'Pulcherrima', style: 'Ausdrucksstark' },
  { name: 'Achird', style: 'Freundlich' },
  { name: 'Zubenelgenubi', style: 'Locker' },
  { name: 'Vindemiatrix', style: 'Sanft' },
  { name: 'Sadachbia', style: 'Lebendig' },
  { name: 'Sadaltager', style: 'Wissend' },
  { name: 'Sulafat', style: 'Warm' }
];
const LIVE_VOICE_NAMES = new Set(LIVE_VOICES.map(voice => voice.name));
const dbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open('bard-ai-pwa', 5);
  request.onupgradeneeded = event => {
    const db = request.result;
    const tx = request.transaction;
    const chats = db.objectStoreNames.contains('chats') ? tx.objectStore('chats') : db.createObjectStore('chats', { keyPath: 'id' });
    const messages = db.objectStoreNames.contains('messages') ? tx.objectStore('messages') : db.createObjectStore('messages', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('voiceSamples')) db.createObjectStore('voiceSamples', { keyPath: 'voiceName' });
    if (db.objectStoreNames.contains('secrets')) db.deleteObjectStore('secrets');
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
  imageMode: false,
  busy: false,
  voice: { active: false, muted: false, intentionalClose: false, isReady: false, sources: new Set(), nextPlayTime: 0, turnUser: '', turnAssistant: '', voiceName: LIVE_VOICE_NAMES.has(localStorage.getItem('bard_live_voice')) ? localStorage.getItem('bard_live_voice') : '' },
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

const workerOrigin = 'https://bard-ai-api.bardai.workers.dev';
async function requestWorker(path, payload) {
  let response;
  try {
    response = await fetch(`${workerOrigin}${path}`, {
      method: 'POST', cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(120000)
    });
  } catch {
    throw new Error('Der Bard-Server ist nicht erreichbar. Prüfe deine Internetverbindung.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(data.error || `Der Bard-Server antwortet mit Status ${response.status}.`).slice(0, 600));
  return data;
}
async function checkWorker() {
  let response;
  try {
    response = await fetch(`${workerOrigin}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
  } catch {
    throw new Error('Der Bard-Server ist nicht erreichbar. Prüfe deine Internetverbindung.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) throw new Error(String(data.error || `Der Bard-Server antwortet mit Status ${response.status}.`));
  setConnection('online', 'Verbunden');
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
function readVoiceSample(name) {
  return dbPromise.then(db => idbRequest(db.transaction('voiceSamples').objectStore('voiceSamples').get(name)));
}
function saveVoiceSample(sample) {
  return dbPromise.then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('voiceSamples', 'readwrite');
    tx.objectStore('voiceSamples').put(sample);
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Hörprobe konnte nicht gespeichert werden.'));
  }));
}

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

function previewMarkup(text) {
  const match = String(text || '').match(/```(html|svg)\s*([\s\S]*?)```/i);
  if (!match) return null;
  const source = match[2].trim();
  if (!source || source.length > 100_000) return null;
  const html = match[1].toLowerCase() === 'svg'
    ? `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1020">${source}</body></html>`
    : source;
  return { source, html, block: match[0] };
}
function renderCodePreview(parent, preview) {
  const card = document.createElement('section');
  card.className = 'generated-preview';
  const heading = document.createElement('div');
  heading.className = 'generated-preview-heading';
  const title = document.createElement('strong');
  title.textContent = 'Live-Vorschau';
  const badge = document.createElement('span');
  badge.textContent = 'HTML · CSS · JS';
  heading.append(title, badge);
  const frame = document.createElement('iframe');
  frame.className = 'generated-preview-frame';
  frame.title = 'Von Bard AI erstellte Code-Vorschau';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.referrerPolicy = 'no-referrer';
  frame.loading = 'lazy';
  frame.addEventListener('load', () => {
    frame.contentWindow?.postMessage({ type: 'bard-preview', html: preview.html }, '*');
  }, { once: true });
  frame.src = new URL('./preview.html', document.baseURI).href;
  const details = document.createElement('details');
  details.className = 'generated-preview-source';
  const summary = document.createElement('summary');
  summary.textContent = 'Quellcode anzeigen';
  const code = document.createElement('pre');
  const codeText = document.createElement('code');
  codeText.textContent = preview.source;
  code.append(codeText);
  details.append(summary, code);
  card.append(heading, frame, details);
  parent.append(card);
}
function addTextParts(parent, text) {
  const paragraphs = String(text || '').split(/\n{2,}/).slice(0, 80);
  for (const content of paragraphs) {
    if (!content.trim()) continue;
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
  const preview = item.role === 'assistant' ? previewMarkup(item.text) : null;
  addTextParts(bubble, preview ? String(item.text).replace(preview.block, '').trim() : item.text);
  if (preview) renderCodePreview(bubble, preview);
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
  const fact = String(value || '').replace(/[\s.!?]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
  if (!fact) return false;
  const key = fact.toLocaleLowerCase('de').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const existing = state.memory.findIndex(item => item.toLocaleLowerCase('de').replace(/[^\p{L}\p{N}]+/gu, ' ').trim() === key);
  if (existing >= 0) state.memory.splice(existing, 1);
  state.memory = [...state.memory, fact].slice(-12);
  localStorage.setItem('bard_memory', JSON.stringify(state.memory)); renderMemory();
  return true;
}
function assistantAskedForName() {
  const previous = [...state.messages].reverse().find(item => item.role === 'assistant');
  return Boolean(previous && /wie\s+(?:darf|soll|kann)\s+ich\s+dich\s+nennen|wie\s+heißt\s+du|wie\s+lautet\s+dein\s+name|was\s+ist\s+dein\s+name|welchen\s+namen\s+(?:soll|darf)\s+ich\s+(?:dir\s+geben|verwenden)/iu.test(previous.text || ''));
}
function captureConversationMemory(text) {
  const normalized = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  let changed = false;
  const name = normalized.match(/(?:\bich heiße|\bich heisse|\bmein name ist|\bnenn mich|\bdu kannst mich nennen)\s+([\p{L}][\p{L}\p{M}'’-]{0,39})/iu);
  if (name?.[1]) { saveUserName(name[1]); changed = true; }
  else if (!state.name && assistantAskedForName()) {
    const shortAnswer = normalized.match(/^([\p{L}][\p{L}\p{M}'’-]{0,39})[.!]?$/iu);
    const filler = new Set(['ja', 'nein', 'okay', 'ok', 'klar', 'hi', 'hallo', 'hey', 'test', 'bro', 'danke']);
    if (shortAnswer && !filler.has(shortAnswer[1].toLocaleLowerCase('de'))) {
      saveUserName(shortAnswer[1]); changed = true;
    }
  }
  const explicit = normalized.match(/(?:\bmerk(?:e)? dir|\bspeicher(?:e)? dir|\bdenk dran|\bmerke bitte)[\s,:-]+(?:dass\s+)?(.+)/iu);
  if (explicit?.[1]) changed = remember(explicit[1]) || changed;
  const stableFact = normalized.match(/\b(ich mag|ich liebe|ich bevorzuge|ich interessiere mich für|ich arbeite als|ich lerne gerade|ich studiere|ich wohne in|ich lebe in|ich spiele gern|ich mache gern|i like|i love|i prefer|i work as|i am learning|i study|i live in)\s+(.+)/iu);
  if (stableFact?.[1]) changed = remember(stableFact[1] + ' ' + stableFact[2]) || changed;
  return changed;
}
function renderMessages() {
  const rows = $('#messages'); rows.replaceChildren();
  for (const item of state.messages) renderMessage(item, false);
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
function requestsCodePreview(text) {
  const value = String(text || '').toLocaleLowerCase('de');
  return /\b(html|css|javascript|js|svg|canvas)\b|webseite|website|landing[- ]?page|prototyp|grafik|diagramm|visualisierung|animation|vorschau|dashboard/.test(value);
}
async function submitPrompt(text = $('#prompt').value.trim()) {
  if (!text || state.busy) return;
  captureConversationMemory(text);
  const userMessage = { id: crypto.randomUUID(), role: 'user', text: safeText(text), created: Date.now() };
  state.messages.push(userMessage); renderMessage(userMessage); void persistMessages().catch(() => {});
  $('#prompt').value = ''; resizePrompt(); state.busy = true; typing(true); setConnection('busy', 'Denkt nach');
  try {
    if (state.imageMode) {
      const result = await requestWorker('/api/image', { prompt: userMessage.text });
      if (!result.image?.data) throw new Error('Der Bilddienst hat kein Bild zurückgegeben.');
      const answer = {
        id: crypto.randomUUID(), role: 'assistant',
        text: safeText(result.text || 'Hier ist dein Bild.'),
        image: { mimeType: result.image.mimeType || 'image/png', data: result.image.data },
        created: Date.now()
      };
      state.messages.push(answer); renderMessage(answer); void persistMessages().catch(() => {});
    } else {
      const messages = state.messages.slice(-40)
        .map(message => ({ role: message.role === 'assistant' ? 'assistant' : 'user', text: String(message.text || '').slice(0, 12000) }))
        .filter(message => message.text.trim());
      const codePreview = !state.imageMode && requestsCodePreview(userMessage.text);
      if (codePreview && messages.length) {
        messages[messages.length - 1].text += '\n\nErstelle für diese Anfrage eine eigenständige, sofort lauffähige Vorschau als genau einen vollständigen ```html-Codeblock. Baue CSS und JavaScript direkt in diese HTML-Datei ein; verwende keine externen Dateien, Bibliotheken, Links oder Netzwerkzugriffe. Erzeuge gewünschte Grafiken direkt mit inline-SVG, Canvas oder CSS, ohne Bildgenerierungsmodell. Gib außerhalb des Codeblocks höchstens eine kurze Erklärung. Die Vorschau ist isoliert und offline; behaupte keine echten Geräteaktionen.';
      }
      const result = await requestWorker('/api/chat', { messages, userName: state.name, memory: state.memory, codePreview });
      const answer = { id: crypto.randomUUID(), role: 'assistant', text: safeText(result.text) || 'Ich habe keine Textantwort erhalten.', created: Date.now() };
      state.messages.push(answer); renderMessage(answer); void persistMessages().catch(() => {});
      if (state.speakReplies) speak(answer.text);
    }
    setConnection('online', 'Verbunden');
  } catch (error) {
    const message = safeText(error.message || 'Die Anfrage ist fehlgeschlagen.');
    setConnection('offline', 'Verbindung fehlt');
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


function voiceState(mode, label, hint) {
  const scene = $('#voiceDialog .voice-scene');
  if (!scene) return;
  scene.dataset.state = mode;
  $('#voiceStateLabel').textContent = label;
  $('#voiceStateHint').textContent = hint || '';
}
function voiceTone(frequency, delay = 0) {
  const ctx = state.voice.audioContext;
  if (!ctx || ctx.state !== 'running' || state.voice.muted) return;
  const start = ctx.currentTime + delay;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, start);
  oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.18, start + 0.11);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.035, start + 0.025);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
  oscillator.connect(gain); gain.connect(ctx.destination);
  oscillator.start(start); oscillator.stop(start + 0.23);
}
function encodePcm16(floatSamples) {
  const bytes = new Uint8Array(floatSamples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < floatSamples.length; i++) {
    const sample = Math.max(-1, Math.min(1, floatSamples[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function decodePcm16(base64) {
  const binary = atob(base64);
  const samples = new Float32Array(Math.floor(binary.length / 2));
  for (let i = 0; i < samples.length; i++) {
    let value = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
    if (value & 0x8000) value -= 0x10000;
    samples[i] = value / 32768;
  }
  return samples;
}
function stopVoicePlayback() {
  const voice = state.voice;
  for (const source of voice.sources) { try { source.stop(); } catch {} }
  voice.sources.clear();
  voice.nextPlayTime = voice.audioContext?.currentTime || 0;
}
function playVoiceAudio(base64) {
  const voice = state.voice, ctx = voice.audioContext;
  if (!ctx || ctx.state !== 'running') return;
  const samples = decodePcm16(base64);
  if (!samples.length) return;
  const buffer = ctx.createBuffer(1, samples.length, 24000);
  buffer.copyToChannel(samples, 0);
  const source = ctx.createBufferSource(); source.buffer = buffer;
  const gain = ctx.createGain(); gain.gain.value = 0.94;
  source.connect(gain); gain.connect(ctx.destination);
  const start = Math.max(ctx.currentTime + 0.035, voice.nextPlayTime || 0);
  voice.nextPlayTime = start + buffer.duration;
  voice.sources.add(source);
  source.onended = () => {
    voice.sources.delete(source);
    if (!voice.sources.size && voice.pendingTurnComplete && state.voice.active) {
      voice.pendingTurnComplete = false;
      voiceState('listening', 'Ich höre zu', 'Du kannst jederzeit weitersprechen.');
    }
  };
  source.start(start);
}
function joinTranscriptText(previous, chunk) {
  const next = safeText(chunk).replace(/\s+/g, ' ').trim();
  if (!next) return previous;
  if (!previous) return next;
  if (next === previous || previous.endsWith(next)) return previous;
  if (next.startsWith(previous)) return next.slice(-2400);
  const needsSpace = /[\p{L}\p{N})\]}.!?…,:;’”»]$/u.test(previous) && /^[\p{L}\p{N}([{“‘]/u.test(next);
  return (previous + (needsSpace ? ' ' : '') + next).slice(-2400);
}
function resetVoiceTranscript() {
  const transcript = $('#voiceTranscript');
  transcript.replaceChildren();
  const empty = document.createElement('p');
  empty.id = 'voiceTranscriptEmpty'; empty.className = 'voice-transcript-empty';
  empty.textContent = 'Dein Gespräch erscheint hier, sobald ihr sprecht.';
  transcript.append(empty);
  state.voice.transcriptUserEntry = null;
  state.voice.transcriptAssistantEntry = null;
}
function appendCaption(role, text) {
  const voice = state.voice;
  const user = role === 'user';
  const bufferKey = user ? 'turnUser' : 'turnAssistant';
  const entryKey = user ? 'transcriptUserEntry' : 'transcriptAssistantEntry';
  const next = joinTranscriptText(voice[bufferKey] || '', text);
  if (!next || next === voice[bufferKey]) return;
  voice[bufferKey] = next;
  const transcript = $('#voiceTranscript');
  $('#voiceTranscriptEmpty')?.remove();
  let entry = voice[entryKey];
  if (!entry) {
    entry = document.createElement('article');
    entry.className = 'voice-transcript-entry ' + (user ? 'user' : 'assistant');
    const speaker = document.createElement('span');
    speaker.className = 'voice-transcript-speaker';
    speaker.textContent = user ? 'DU' : 'BARD AI';
    const content = document.createElement('p');
    content.className = 'voice-transcript-text';
    entry.append(speaker, content);
    transcript.append(entry);
    voice[entryKey] = entry;
  }
  entry.querySelector('.voice-transcript-text').textContent = next;
  while (transcript.querySelectorAll('.voice-transcript-entry').length > 36) {
    transcript.querySelector('.voice-transcript-entry')?.remove();
  }
  transcript.scrollTo({ top: transcript.scrollHeight, behavior: 'smooth' });
}
function handleVoiceMessage(message) {
  const voice = state.voice;
  if (message.error?.message) { voiceFailure(String(message.error.message).slice(0, 300)); return; }
  const content = message.serverContent;
  if (!content) return;
  const input = content.inputTranscription?.text || content.input_transcription?.text;
  const output = content.outputTranscription?.text || content.output_transcription?.text;
  if (input) appendCaption('user', input);
  if (output) appendCaption('assistant', output);
  if (content.interrupted) {
    stopVoicePlayback(); voice.pendingTurnComplete = false;
    voiceState('listening', 'Ich höre zu', 'Sag einfach weiter — ich bin bei dir.');
  }
  const parts = content.modelTurn?.parts || content.model_turn?.parts || [];
  for (const part of parts) {
    const inline = part.inlineData || part.inline_data;
    if (inline?.data) {
      voiceState('speaking', 'Bard AI spricht', 'Du kannst mich jederzeit unterbrechen.');
      playVoiceAudio(inline.data);
    }
  }
  if (content.turnComplete || content.turn_complete) {
    saveVoiceTurn();
    voice.pendingTurnComplete = true;
    if (!voice.sources.size) {
      voice.pendingTurnComplete = false;
      voiceState('listening', 'Ich höre zu', 'Du kannst jederzeit weitersprechen.');
    }
  } else if ((content.inputTranscription || content.input_transcription) && !parts.length) {
    voiceState('thinking', 'Ich denke nach', 'Ich habe dich gehört und formuliere eine Antwort.');
  }
}
async function startVoiceCapture() {
  const voice = state.voice, ctx = voice.audioContext;
  if (!voice.stream || !ctx || !ctx.audioWorklet) throw new Error('Dieser Browser unterstützt den Live-Audiomodus nicht. Bitte aktualisiere deinen Browser.');
  const workletUrl = new URL('pcm-capture.js', document.baseURI).href;
  await ctx.audioWorklet.addModule(workletUrl);
  const source = ctx.createMediaStreamSource(voice.stream);
  const processor = new AudioWorkletNode(ctx, 'bard-pcm-capture');
  const silent = ctx.createGain(); silent.gain.value = 0;
  processor.port.onmessage = event => {
    if (!state.voice.active || state.voice.muted || !voice.socket || voice.socket.readyState !== WebSocket.OPEN) return;
    const data = encodePcm16(new Float32Array(event.data));
    voice.socket.send(JSON.stringify({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } }));
  };
  source.connect(processor); processor.connect(silent); silent.connect(ctx.destination);
  voice.sourceNode = source; voice.processor = processor; voice.silentGain = silent;
}
function stopVoiceCapture() {
  const voice = state.voice;
  try { voice.processor?.disconnect(); } catch {}
  try { voice.sourceNode?.disconnect(); } catch {}
  try { voice.silentGain?.disconnect(); } catch {}
  voice.processor?.port && (voice.processor.port.onmessage = null);
  voice.processor = voice.sourceNode = voice.silentGain = null;
  for (const track of voice.stream?.getTracks?.() || []) track.stop();
  voice.stream = null;
}
function voiceFailure(message) {
  const voice = state.voice;
  if (!voice.active) return;
  voice.active = false; voice.isReady = false;
  stopVoiceCapture(); stopVoicePlayback();
  try { voice.socket?.close(); } catch {}
  voice.audioContext?.close().catch(() => {}); voice.audioContext = null;
  voice.socket = null;
  voiceState('error', 'Verbindung unterbrochen', message || 'Der Live-Sprachkanal konnte nicht gestartet werden.');
  $('#voiceRetry').classList.remove('hidden');
  $('#voiceMute').classList.add('hidden');
}
function saveVoiceTurn() {
  const voice = state.voice;
  const userText = safeText(voice.turnUser).trim();
  const assistantText = safeText(voice.turnAssistant).trim();
  voice.turnUser = ''; voice.turnAssistant = '';
  voice.transcriptUserEntry = null; voice.transcriptAssistantEntry = null;
  if (userText) captureConversationMemory(userText);
  const created = Date.now();
  if (userText) {
    const message = { id: crypto.randomUUID(), role: 'user', text: userText, created };
    state.messages.push(message); renderMessage(message, false);
  }
  if (assistantText) {
    const message = { id: crypto.randomUUID(), role: 'assistant', text: assistantText, created: created + 1 };
    state.messages.push(message); renderMessage(message, false);
  }
  if (userText || assistantText) {
    $('#welcome').classList.add('compact');
    void persistMessages().catch(() => notice('Das Sprachgespräch konnte lokal nicht gespeichert werden.', true));
  }
}
async function startLiveVoice(keepDialog = false) {
  const voice = state.voice;
  if (voice.active) return;
  if (!keepDialog && !$('#voiceDialog').open) $('#voiceDialog').showModal();
  voice.active = true; voice.muted = false; voice.intentionalClose = false; voice.isReady = false; voice.pendingTurnComplete = false; voice.turnUser = ''; voice.turnAssistant = '';
  voice.sources = new Set(); voice.nextPlayTime = 0;
  $('#voiceRetry').classList.add('hidden'); $('#voiceMute').classList.remove('hidden');
  $('#voiceButton').classList.add('listening'); $('#voiceButton').lastElementChild.textContent = 'Live-Gespräch läuft';
  $('#voiceMute').setAttribute('aria-pressed', 'false');
  $('#voiceMute').lastElementChild.textContent = 'Mikro stumm';
  resetVoiceTranscript();
  setConnection('busy', 'Bard AI Live');
  voiceState('connecting', 'Live-Verbindung wird aufgebaut', 'Verbinde sicher mit Bard AI Live.');
  try {
    voice.audioContext = new AudioContext({ latencyHint: 'interactive' });
    await voice.audioContext.resume();
    voice.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const result = await requestWorker('/api/live-token', {
      userName: state.name,
      memory: state.memory,
      voiceName: voice.voiceName,
      context: state.messages.slice(-12).map(item => ({ role: item.role, text: String(item.text || '').slice(0, 1000) }))
    });
    if (!result.token || !result.model || !result.config) throw new Error('Der Live-Server hat keine sichere Sitzung bereitgestellt. Bitte aktualisiere den Worker.');
    const liveConfig = { ...result.config };
    if (voice.voiceName) {
      const generationConfig = liveConfig.generationConfig || {};
      liveConfig.generationConfig = {
        ...generationConfig,
        speechConfig: {
          ...(generationConfig.speechConfig || {}),
          voiceConfig: {
            ...(generationConfig.speechConfig?.voiceConfig || {}),
            prebuiltVoiceConfig: { voiceName: voice.voiceName }
          }
        }
      };
    }
    const socketUrl = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=' + encodeURIComponent(result.token);
    const socket = new WebSocket(socketUrl); socket.binaryType = 'arraybuffer'; voice.socket = socket;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback(value);
      };
      const timeout = setTimeout(() => {
        finish(reject, new Error('Der Live-Kanal hat innerhalb von 45 Sekunden keine Setup-Bestätigung gesendet.'));
        try { socket.close(4000, 'Setup timeout'); } catch {}
      }, 45000);
      socket.onopen = () => {
        try { socket.send(JSON.stringify({ setup: { model: result.model, ...liveConfig } })); }
        catch { finish(reject, new Error('Die Live-Konfiguration konnte nicht gesendet werden.')); }
      };
      socket.onmessage = async event => {
        let message;
        try {
          const data = event.data;
          const text = typeof data === 'string' ? data
            : data instanceof Blob ? await data.text()
            : data instanceof ArrayBuffer ? new TextDecoder().decode(data)
            : ArrayBuffer.isView(data) ? new TextDecoder().decode(data)
            : '';
          if (!text) throw new TypeError('Leere oder unbekannte Nachricht');
          message = JSON.parse(text);
        } catch (error) {
          const detail = error instanceof TypeError ? 'Format ' + (event.data?.constructor?.name || typeof event.data) : 'ungültiges JSON';
          finish(reject, new Error('Live-Kanal-Nachricht konnte nicht gelesen werden (' + detail + ').'));
          return;
        }
        if (message.setupComplete || message.setup_complete) {
          finish(resolve);
          return;
        }
        if (message.error?.message) {
          finish(reject, new Error(String(message.error.message).slice(0, 300)));
          return;
        }
        handleVoiceMessage(message);
      };
      socket.onerror = () => finish(reject, new Error('Die Verbindung zu Bard AI Live ist fehlgeschlagen.'));
      socket.onclose = event => {
        if (!voice.active || voice.intentionalClose) return;
        const detail = event.reason ? event.reason.slice(0, 180) : 'Code ' + event.code;
        if (!voice.isReady) finish(reject, new Error('Der Live-Kanal wurde beim Verbindungsaufbau geschlossen (' + detail + ').'));
        else voiceFailure('Die Live-Verbindung wurde beendet (' + detail + '). Starte den Sprachmodus erneut.');
      };
    });
    if (!voice.active) return;
    voice.isReady = true;
    await startVoiceCapture();
    voiceTone(660); voiceTone(880, 0.12);
    voiceState('listening', 'Ich höre zu', 'Sag einfach, was dir gerade durch den Kopf geht.');
  } catch (error) {
    voiceFailure(error.message || 'Mikrofon oder Live-Verbindung ist nicht verfügbar.');
    if (!voice.active) return;
  }
}
function stopLiveVoice(closeDialog = true) {
  const voice = state.voice;
  voice.active = false; voice.intentionalClose = true; voice.isReady = false;
  stopVoiceCapture(); stopVoicePlayback();
  if (voice.socket) { try { voice.socket.close(1000, 'User ended session'); } catch {} }
  voice.socket = null;
  voice.audioContext?.close().catch(() => {});
  voice.audioContext = null;
  setConnection('online', 'Verbunden'); voice.intentionalClose = false;
  if (closeDialog && $('#voiceDialog').open) $('#voiceDialog').close();
  $('#voiceButton').classList.remove('listening');
  $('#voiceButton').lastElementChild.textContent = 'Bard AI Live';
  if ($('#voiceDialog').open) voiceState('idle', 'Gespräch beendet', 'Du kannst den Sprachmodus jederzeit erneut starten.');
}
function toggleVoiceMute() {
  const voice = state.voice;
  if (!voice.active || !voice.stream) return;
  voice.muted = !voice.muted;
  for (const track of voice.stream.getAudioTracks()) track.enabled = !voice.muted;
  $('#voiceMute').setAttribute('aria-pressed', String(voice.muted));
  $('#voiceMute').lastElementChild.textContent = voice.muted ? 'Mikro einschalten' : 'Mikro stumm';
  voiceState(voice.muted ? 'muted' : 'listening', voice.muted ? 'Mikrofon stumm' : 'Ich höre zu', voice.muted ? 'Bard AI wartet, bis du dein Mikro wieder einschaltest.' : 'Du kannst jederzeit weitersprechen.');
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
$('#imageButton').addEventListener('click', toggleImageMode);
$('#sendButton').addEventListener('click', () => void submitPrompt());
$('#prompt').addEventListener('input', resizePrompt);
$('#prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submitPrompt(); } });

$('#voiceButton').addEventListener('click', () => void startLiveVoice());
$('#voiceClose').addEventListener('click', () => stopLiveVoice());
$('#voiceEnd').addEventListener('click', () => { voiceTone(440); stopLiveVoice(); });
$('#voiceMute').addEventListener('click', toggleVoiceMute);
function updateVoicePickerTrigger() {
  $('#voiceSelectedLabel').textContent = LIVE_VOICES.find(voice => voice.name === state.voice.voiceName)?.name || 'Standard';
}
let voicePreviewRun = 0;
let voicePreviewAudio = null;
let voicePreviewContext = null;
function stopVoicePreview() {
  voicePreviewRun += 1;
  if (voicePreviewAudio?.source) {
    try { voicePreviewAudio.source.stop(); } catch {}
  }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  voicePreviewAudio = null;
  if (voicePreviewContext) {
    voicePreviewContext.close().catch(() => {});
    voicePreviewContext = null;
  }
}
function playSystemVoicePreview(name, button, run) {
  if (!('speechSynthesis' in window)) return false;
  voicePreviewContext?.close().catch(() => {});
  voicePreviewContext = null;
  const utterance = new SpeechSynthesisUtterance('Hallo! Ich bin Bard AI. Schön, dass du da bist. Womit kann ich dir helfen?');
  utterance.lang = 'de-DE';
  const systemVoices = speechSynthesis.getVoices().filter(item => item.lang?.toLowerCase().startsWith('de'));
  if (systemVoices.length) {
    const index = [...name].reduce((sum, char) => sum + char.codePointAt(0), 0) % systemVoices.length;
    utterance.voice = systemVoices[index];
  }
  const style = LIVE_VOICES.find(item => item.name === name)?.style || '';
  utterance.pitch = /hell|jugendlich|lebhaft|lebendig/i.test(style) ? 1.12 : /rau|bestimmt|informativ|reif/i.test(style) ? 0.9 : 1;
  utterance.rate = /energiegeladen|lebhaft|lebendig/i.test(style) ? 1.04 : 0.98;
  utterance.onend = () => {
    if (run !== voicePreviewRun || voicePreviewAudio?.utterance !== utterance) return;
    voicePreviewAudio = null;
    button.textContent = '▶ Anhören';
    $('#voicePickerStatus').textContent = name + ' · System-Hörprobe beendet';
  };
  utterance.onerror = () => {
    if (run !== voicePreviewRun) return;
    voicePreviewAudio = null;
    button.textContent = '▶ Anhören';
    $('#voicePickerStatus').textContent = 'Die lokale Browser-Hörprobe konnte nicht abgespielt werden.';
  };
  voicePreviewAudio = { name, utterance };
  speechSynthesis.speak(utterance);
  button.textContent = '■ Stoppen';
  $('#voicePickerStatus').textContent = name + ' · lokale System-Hörprobe (die Live-Stimme klingt anders)';
  return true;
}
function voiceSampleBlob(sample) {
  const bytes = Uint8Array.from(atob(sample.data), char => char.charCodeAt(0));
  const mimeType = sample.mimeType || 'audio/wav';
  if (/wav/i.test(mimeType)) return new Blob([bytes], { type: mimeType });
  const rate = Number(mimeType.match(/rate=(\d+)/i)?.[1]) || 24000;
  const wav = new ArrayBuffer(44 + bytes.length);
  const view = new DataView(wav);
  const writeText = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  writeText(0, 'RIFF'); view.setUint32(4, 36 + bytes.length, true); writeText(8, 'WAVE');
  writeText(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); writeText(36, 'data');
  view.setUint32(40, bytes.length, true); new Uint8Array(wav, 44).set(bytes);
  return new Blob([wav], { type: 'audio/wav' });
}
async function playVoicePreview(name, button) {
  if (voicePreviewAudio?.name === name) {
    stopVoicePreview();
    button.textContent = '▶ Anhören';
    $('#voicePickerStatus').textContent = 'Hörprobe angehalten.';
    return;
  }
  stopVoicePreview();
  const run = voicePreviewRun;
  button.disabled = true;
  button.textContent = 'Lädt …';
  $('#voicePickerStatus').textContent = `Hörprobe für ${name} wird erstellt …`;
  try {
    // Unlock audio during the click, before waiting for the network response.
    voicePreviewContext = new AudioContext({ latencyHint: 'interactive' });
    await voicePreviewContext.resume();
    let sample = await readVoiceSample(name);
    if (!sample) {
      sample = await requestWorker('/api/voice-preview', { voiceName: name });
      await saveVoiceSample(sample);
    }
    if (run !== voicePreviewRun) return;
    const audioBuffer = await voicePreviewContext.decodeAudioData(await voiceSampleBlob(sample).arrayBuffer());
    if (run !== voicePreviewRun) return;
    const source = voicePreviewContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(voicePreviewContext.destination);
    voicePreviewAudio = { name, source };
    source.onended = () => {
      if (voicePreviewAudio?.source !== source) return;
      stopVoicePreview();
      const current = document.querySelector(`[data-preview-voice="${name}"]`);
      if (current) current.textContent = '▶ Anhören';
      $('#voicePickerStatus').textContent = `${name} · Hörprobe beendet`;
    };
    source.start();
    button.textContent = '■ Stoppen';
    $('#voicePickerStatus').textContent = `${name} · Hörprobe läuft`;
  } catch (error) {
    if (run === voicePreviewRun) {
      if (!playSystemVoicePreview(name, button, run)) {
        stopVoicePreview();
        $('#voicePickerStatus').textContent = error.message || 'Die Hörprobe ist gerade nicht verfügbar.';
      }
    }
  } finally {
    button.disabled = false;
    if (run !== voicePreviewRun || voicePreviewAudio?.name !== name) button.textContent = '▶ Anhören';
  }
}
function renderVoicePicker() {
  const list = $('#voicePickerList');
  list.replaceChildren();
  for (const voice of LIVE_VOICES) {
    const card = document.createElement('article');
    const selected = state.voice.voiceName === voice.name;
    card.className = `voice-choice-card${selected ? ' selected' : ''}`;
    const label = document.createElement('div');
    const name = document.createElement('strong'); name.className = 'voice-choice-name'; name.textContent = voice.name;
    const style = document.createElement('span'); style.className = 'voice-choice-style'; style.textContent = voice.style;
    label.append(name, style);
    const actions = document.createElement('div'); actions.className = 'voice-choice-actions';
    const preview = document.createElement('button'); preview.type = 'button'; preview.dataset.previewVoice = voice.name; preview.textContent = '▶ Anhören';
    preview.addEventListener('click', () => void playVoicePreview(voice.name, preview));
    const use = document.createElement('button'); use.type = 'button'; use.className = 'voice-choice-use'; use.setAttribute('aria-pressed', String(selected)); use.textContent = selected ? 'Ausgewählt' : 'Verwenden';
    use.addEventListener('click', () => {
      state.voice.voiceName = voice.name;
      localStorage.setItem('bard_live_voice', voice.name);
      updateVoicePickerTrigger();
      renderVoicePicker();
      $('#voicePickerStatus').textContent = `${voice.name} wird ab dem nächsten Live-Gespräch verwendet.`;
    });
    actions.append(preview, use); card.append(label, actions); list.append(card);
  }
}
updateVoicePickerTrigger();
function openVoicePicker() {
  renderVoicePicker();
  $('#voicePickerStatus').textContent = '';
  $('#voicePickerDialog').showModal();
}
$('#voicePickerOpen').addEventListener('click', openVoicePicker);
$('#voicePickerSettingsOpen').addEventListener('click', openVoicePicker);
$('#voicePickerClose').addEventListener('click', () => $('#voicePickerDialog').close());
$('#voicePickerDialog').addEventListener('close', stopVoicePreview);
$('#voicePickerDialog').addEventListener('click', event => { if (event.target === $('#voicePickerDialog')) $('#voicePickerDialog').close(); });
$('#voiceRetry').addEventListener('click', () => { stopLiveVoice(false); void startLiveVoice(true); });
$('#voiceDialog').addEventListener('cancel', event => { event.preventDefault(); stopLiveVoice(); });
$('#voiceDialog').addEventListener('close', () => { if (state.voice.active) stopLiveVoice(false); });

window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); state.installPrompt = event; $('#installButton').classList.remove('hidden'); });
$('#installButton').addEventListener('click', async () => { if (!state.installPrompt) return; await state.installPrompt.prompt(); state.installPrompt = null; $('#installButton').classList.add('hidden'); });
window.addEventListener('pagehide', () => stopLiveVoice(false));
restoreMessages().catch(() => notice('Der lokale Chatverlauf konnte nicht geladen werden.', true));
checkWorker().catch(error => { setConnection('offline', 'Nicht erreichbar'); notice(error.message, true); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});


