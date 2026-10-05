const $ = selector => document.querySelector(selector);

// Reduce visual work on constrained devices without interrupting media capture.
const lowMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const lowHardware = (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4)
  || (navigator.deviceMemory && navigator.deviceMemory <= 4);
if (lowMotion || lowHardware) document.documentElement.classList.add('low-power');
document.addEventListener('visibilitychange', () => {
  document.documentElement.classList.toggle('page-hidden', document.hidden);
}, { passive: true });
function readStored(key) { try { return localStorage.getItem(key); } catch { return null; } }
function writeStored(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } }
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
function isSensitiveMemoryFact(value) {
  const text = String(value || '');
  return [
    /\b(?:adresse|anschrift|postanschrift|wohnort|postleitzahl|plz|street address|home address|zip code)\b/iu,
    /\b(?:telefonnummer|handynummer|mobilnummer|e-?mail(?:adresse)?|email address|phone number)\b/iu,
    /\b(?:diagnose|allerg(?:ie|isch)|medikament|verschreibung|schwanger|geburtstag|geburtsdatum|krankheit|gesundheitszustand|blood pressure|medical condition|pregnan|medication|diagnosis|birthday|date of birth)\b/iu,
    /\b(?:einkommen|gehalt|budget|finanzen|bankkonto|konto|kreditkarte|schulden|ich verdiene|salary|income|financ|bank account|credit card|debt)\b/iu,
    /\b(?:ich wohne in|ich lebe in|mein wohnort|i live at|my home is)\b/iu
  ].some(pattern => pattern.test(text));
}

const dbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open('bard-ai-pwa', 7);
  request.onupgradeneeded = event => {
    const db = request.result;
    const tx = request.transaction;
    const chats = db.objectStoreNames.contains('chats') ? tx.objectStore('chats') : db.createObjectStore('chats', { keyPath: 'id' });
    const messages = db.objectStoreNames.contains('messages') ? tx.objectStore('messages') : db.createObjectStore('messages', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('voiceSamples')) db.createObjectStore('voiceSamples', { keyPath: 'voiceName' });
    if (!db.objectStoreNames.contains('profile')) db.createObjectStore('profile', { keyPath: 'key' });
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
  voice: { active: false, muted: false, intentionalClose: false, isReady: false, sources: new Set(), nextPlayTime: 0, outputActive: false, deferredInputAudio: [], deferredInputSamples: 0, deferredInputSpeech: false, deferredInputQuietFrames: 0, deferredInputPreRoll: [], flushingDeferredInput: false, turnUser: '', turnAssistant: '', pendingPreview: null, visualStream: null, visualType: '', visualTimer: null, visualBusy: false, previewTranscriptEntry: null, voiceName: LIVE_VOICE_NAMES.has(readStored('bard_live_voice')) ? readStored('bard_live_voice') : 'Puck' },
  recognition: null,
  recognitionTimer: null,
  recognitionWatchdog: null,
  recognitionLastActivity: 0,
  restartDelay: 350,
  installPrompt: null,
  name: readStored('bard_user_name') || '',
  memory: (() => { try { const value = JSON.parse(readStored('bard_memory') || '[]'); return Array.isArray(value) ? value.filter(item => typeof item === 'string' && !isSensitiveMemoryFact(item)).slice(-24) : []; } catch { return []; } })(),
  recentContext: (() => { try { const value = JSON.parse(readStored('bard_recent_context') || '[]'); return Array.isArray(value) ? value.filter(item => item && typeof item.text === 'string').slice(-16) : []; } catch { return []; } })(),
  theme: localStorage.getItem('bard_theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
  messages: [],
  chatId: readStored('bard_active_chat') || '',
  pendingAttachment: null,
  dictation: null,
  dictationLive: null,
  dictationStopRequested: false,
  dictationStarted: false
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
  if (!response.ok) {
    const detail = String(data.error || '');
    const error = new Error(friendlyRequestError(response.status));
    error.status = response.status;
    if (response.status === 429 && /zu viele live-verbindungsstarts/i.test(detail)) error.failureKind = 'live-burst';
    else if (response.status === 429 && /tageslimit/i.test(detail)) error.failureKind = 'daily-limit';
    else if (/resource[_ ]exhausted|current quota|quota exceeded|exceeded your current quota|rate limit/i.test(detail)) error.failureKind = 'provider-quota';
    throw error;
  }
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
function friendlyRequestError(status) {
  if (status === 429) return 'Hm, gerade klappt das nicht. Versuch es bitte später noch einmal.';
  if (status === 408 || status === 504) return 'Das dauert gerade länger als erwartet. Versuch es bitte gleich noch einmal.';
  if (!status || status >= 500) return 'Uups, Bard AI ist gerade nicht erreichbar. Versuch es bitte gleich noch einmal.';
  return 'Hm, Bard AI konnte darauf gerade nicht antworten. Versuch es bitte noch einmal.';
}
function friendlyFailure(error, feature = 'text') {
  if (feature === 'text' && error?.failureKind === 'live-burst') return 'Zu viele Verbindungsstarts in kurzer Zeit. Warte bitte ein paar Minuten; deine Nachricht steht noch hier.';
  if (feature === 'text' && error?.failureKind === 'daily-limit') return 'Das Tageslimit für diese Funktion ist erreicht. Deine Nachricht steht noch hier.';
  if (isProviderQuotaError(error)) return feature === 'voice'
    ? 'Der Sprachdienst ist gerade ausgelastet. Versuch es bitte später noch einmal.'
    : 'Bard AI ist gerade ausgelastet. Deine Nachricht steht noch hier.';
  if (feature === 'text' && error?.liveFailure === 'request') return 'Der Live-Kanal hat die Anfrage abgelehnt. Deine Nachricht steht noch hier; bitte lade Bard AI neu.';
  if (feature === 'text' && error?.liveFailure === 'blocked') return 'Der Live-Kanal konnte diese Nachricht nicht verarbeiten. Deine Nachricht steht noch hier.';
  if (feature === 'text' && error?.liveCloseCode) return `Der Live-Kanal wurde vor der Antwort mit Verbindungscode ${error.liveCloseCode} beendet. Deine Nachricht steht noch hier.`;
  if (!error?.status || error.status >= 500 || error.status === 408 || error.status === 504) return feature === 'voice'
    ? 'Uups, die Sprachverbindung ist kurz gestolpert. Versuch es bitte erneut.'
    : 'Uups, Bard AI ist gerade kurz gestolpert. Deine Nachricht steht noch hier – versuch es bitte gleich noch einmal.';
  return feature === 'voice'
    ? 'Der Sprachmodus konnte gerade nicht starten. Versuch es bitte noch einmal.'
    : 'Hm, Bard AI konnte gerade nicht antworten. Deine Nachricht steht noch hier – probier es bitte noch einmal.';
}
function setConnection(value, label) {
  const element = $('#connectionState');
  element.className = `connection ${value}`;
  element.lastChild.textContent = ` ${label}`;
}
function safeText(text) { return String(text || '').replace(/\u0000/g, '').slice(0, 60000); }
function buildPreviousContext() {
  return state.recentContext.filter(item => item.chatId !== state.chatId).slice(-8).map(item => ({ role: item.role, text: item.text.slice(0, 1000) }));
}
function buildLiveContext() {
  const previous = buildPreviousContext();
  const active = state.messages.slice(-10).map(item => ({ role: item.role, text: String(item.text || '').slice(0, 1000) })).filter(item => item.text.trim());
  return [...previous, ...active].slice(-12);
}
function mergeRecentContext(rows, chatId) {
  const previous = state.recentContext.filter(item => item.chatId !== chatId);
  const current = rows.slice(-8).filter(item => item.text && item.text.trim()).map(item => ({ id: item.id, chatId, role: item.role, text: String(item.text).slice(0, 1000), created: Number(item.created) || Date.now() }));
  state.recentContext = [...previous, ...current].sort((a, b) => a.created - b.created).slice(-16);
  writeStored('bard_recent_context', JSON.stringify(state.recentContext));
}
function persistMessages() {
  return dbPromise.then(db => new Promise((resolve, reject) => {
    if (!state.chatId) { reject(new Error('Kein aktiver Chat ausgewählt.')); return; }
    const tx = db.transaction(['messages', 'chats'], 'readwrite');
    const store = tx.objectStore('messages');
    const chatId = state.chatId;
    const rows = state.messages.slice(-80);
    const keep = new Set(rows.map(message => message.id));
    const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
    const cursorRequest = store.index('chatTime').openCursor(range);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) { if (!keep.has(cursor.value.id)) cursor.delete(); cursor.continue(); return; }
      const imageRows = rows.filter(message => message.image).slice(-8);
      const keepImages = new Set(imageRows.map(message => message.id));
      for (const message of rows) {
        const row = { ...message, chatId: state.chatId, created: Number(message.created) || Date.now() };
        if (row.image && !keepImages.has(row.id)) delete row.image;
        delete row.searchSuggestion;
        store.put(row);
      }
      const chats = tx.objectStore('chats');
      const chatRequest = chats.get(chatId);
      chatRequest.onsuccess = () => {
        const chat = chatRequest.result;
        if (!chat) return;
        const firstUserMessage = rows.find(message => message.role === 'user');
        if (firstUserMessage && (!chat.title || chat.title === 'Neues Gespräch' || chat.title === 'Bisheriger Chat')) chat.title = firstUserMessage.text.slice(0, 60);
        chat.updated = Date.now(); chats.put(chat);
      };
    };
    tx.oncomplete = () => { mergeRecentContext(rows, chatId); resolve(); };
    tx.onerror = () => reject(tx.error || new Error('Der Chat konnte nicht gespeichert werden.'));
    tx.onabort = () => reject(tx.error || new Error('Der Chat konnte nicht gespeichert werden.'));
  }));
}
function idbRequest(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
function persistProfile() {
  const name = state.name.trim().slice(0, 60);
  const memory = state.memory.slice(-24);
  writeStored('bard_user_name', name);
  writeStored('bard_memory', JSON.stringify(memory));
  const record = { key: 'user', name, memory, updated: Date.now() };
  return dbPromise.then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('profile', 'readwrite');
    tx.objectStore('profile').put(record);
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Profil konnte nicht gespeichert werden.'));
  }));
}
async function restoreProfile() {
  const db = await dbPromise;
  const backup = await idbRequest(db.transaction('profile').objectStore('profile').get('user'));
  const storedName = readStored('bard_user_name');
  const storedMemory = readStored('bard_memory');
  if (storedName !== null) state.name = storedName.trim().slice(0, 60);
  else if (backup?.name) state.name = String(backup.name).trim().slice(0, 60);
  if (storedMemory !== null) {
    try { const value = JSON.parse(storedMemory); state.memory = Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(-24) : []; } catch { state.memory = []; }
  } else if (Array.isArray(backup?.memory)) state.memory = backup.memory.filter(item => typeof item === 'string').slice(-24);
  const migrationKey = 'bard_memory_sensitive_purged_v1';
  if (readStored(migrationKey) !== 'done') {
    const filteredMemory = state.memory.filter(item => !isSensitiveMemoryFact(item));
    if (filteredMemory.length !== state.memory.length) {
      state.memory = filteredMemory;
      try { await persistProfile(); writeStored(migrationKey, 'done'); } catch {}
    } else writeStored(migrationKey, 'done');
  }
  writeStored('bard_user_name', state.name);
  writeStored('bard_memory', JSON.stringify(state.memory));
  $('#userName').value = state.name;
  if (state.name) { $('#nameForm').classList.add('hidden'); $('#welcome').classList.remove('needs-name'); }
  else { $('#nameForm').classList.remove('hidden'); $('#welcome').classList.add('needs-name'); }
  renderMemory();
  if (storedName === null || storedMemory === null) await persistProfile();
}
async function restoreRecentContext(db) {
  const rows = await idbRequest(db.transaction('messages').objectStore('messages').getAll());
  if (!rows.length) return;
  state.recentContext = rows.filter(item => item.text && item.text.trim()).sort((a, b) => a.created - b.created).slice(-16).map(item => ({ id: item.id, chatId: item.chatId, role: item.role, text: String(item.text).slice(0, 1000), created: Number(item.created) || Date.now() }));
  writeStored('bard_recent_context', JSON.stringify(state.recentContext));
}
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
  await restoreRecentContext(db);
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
  scrollConversationToBottom();
  if (state.messages.length) $('#welcome').classList.add('compact');
  if (!state.name) { $('#welcome').classList.add('needs-name'); $('#nameForm').classList.remove('hidden'); }
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
  const match = String(text || '').match(/```(html|svg)\s*([\s\S]*?)(?:```|$)/i);
  if (!match) return null;
  const source = match[2].trim();
  if (!source || source.length > 100_000) return null;
  let html = match[1].toLowerCase() === 'svg'
    ? `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1020">${source}</body></html>`
    : source;
  if (!/<meta\b[^>]*name=["']viewport["']/i.test(html)) {
    const viewport = '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">';
    if (/<head\b[^>]*>/i.test(html)) html = html.replace(/<head\b[^>]*>/i, match => match + viewport);
    else if (/<html\b[^>]*>/i.test(html)) html = html.replace(/<html\b[^>]*>/i, match => match + '<head>' + viewport + '</head>');
    else html = `<!doctype html><html lang="de"><head><meta charset="utf-8">${viewport}</head><body>${html}</body></html>`;
  }
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
  frame.loading = 'eager';
  frame.addEventListener('load', () => {
    frame.contentWindow?.postMessage({ type: 'bard-preview', html: preview.html }, '*');
    scrollConversationToBottom();
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
function renderSearchSuggestion(parent, markup, live = false) {
  if (typeof markup !== 'string' || !markup.trim() || markup.length > 24_000) return;
  const frame = document.createElement('iframe'); frame.className = 'search-suggestion-frame';
  frame.title = 'Google-Suchvorschläge zu dieser Antwort'; frame.setAttribute('sandbox', 'allow-scripts');
  frame.referrerPolicy = 'no-referrer'; frame.loading = 'lazy'; frame.srcdoc = markup;
  if (live) frame.classList.add('live');
  parent.append(frame);
  if (live) parent.scrollTo({ top: parent.scrollHeight, behavior: 'smooth' });
}
function renderSources(parent, sources) {
  const safeSources = (Array.isArray(sources) ? sources : []).filter(source => {
    try { return source?.title && new URL(source.url).protocol === 'https:'; } catch { return false; }
  }).slice(0, 8);
  if (!safeSources.length) return;
  const section = document.createElement('details'); section.className = 'message-sources';
  const summary = document.createElement('summary'); summary.textContent = `Webquellen (${safeSources.length})`;
  const list = document.createElement('ul');
  for (const source of safeSources) {
    const item = document.createElement('li'); const link = document.createElement('a');
    link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = String(source.title).slice(0, 180);
    item.append(link); list.append(item);
  }
  section.append(summary, list); parent.append(section);
}
function addTextParts(parent, text) {
  const paragraphs = String(text || '').split(/\n{2,}/);
  for (const content of paragraphs) {
    if (!content.trim()) continue;
    const p = document.createElement('p');
    p.textContent = content;
    parent.append(p);
  }
}
const bottomScrollFrames = new WeakMap();
function getConversationScrollTarget() {
  const conversation = $('.conversation');
  if (conversation && conversation.scrollHeight - conversation.clientHeight > 2) return conversation;
  return document.scrollingElement || document.documentElement;
}
function updateScrollToBottomButton() {
  const target = getConversationScrollTarget();
  const button = $('#scrollToBottom');
  if (!target || !button) return;
  const page = target === document.scrollingElement || target === document.documentElement;
  const top = page ? window.scrollY : target.scrollTop;
  const viewport = page ? window.innerHeight : target.clientHeight;
  button.hidden = target.scrollHeight - viewport - top < 96;
  if (button.hidden) return;
  const inputRect = $('#prompt')?.getBoundingClientRect();
  if (!inputRect) return;
  button.style.left = `${inputRect.left + inputRect.width / 2}px`;
  button.style.top = `${Math.max(8, inputRect.top - button.offsetHeight - 8)}px`;
  button.style.bottom = 'auto';
}
function scrollToBottom(element, behavior = 'auto') {
  if (!element || bottomScrollFrames.has(element)) return;
  const page = element === document.scrollingElement || element === document.documentElement;
  const move = () => {
    if (page) window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
    else element.scrollTo({ top: element.scrollHeight, behavior });
    if (element === getConversationScrollTarget()) updateScrollToBottomButton();
  };
  const frame = requestAnimationFrame(() => {
    move();
    bottomScrollFrames.set(element, requestAnimationFrame(() => {
      move();
      bottomScrollFrames.delete(element);
    }));
  });
  bottomScrollFrames.set(element, frame);
}
let conversationResizeObserver = null;
function scrollConversationToBottom(smooth = false) {
  const conversation = $('.conversation');
  if (!conversation) return;
  const messages = $('#messages');
  if (!conversationResizeObserver && messages && 'ResizeObserver' in window) {
    conversationResizeObserver = new ResizeObserver(() => scrollConversationToBottom());
    conversationResizeObserver.observe(messages);
  }
  scrollToBottom(getConversationScrollTarget(), smooth ? 'smooth' : 'auto');
}
function isBardApplicationMarkup(source) {
  const html = String(source || '');
  const markers = [
    /id\s*=\s*["']voiceDialog["']/i,
    /id\s*=\s*["']settingsDialog["']/i,
    /id\s*=\s*["']dictationButton["']/i,
    /id\s*=\s*["']voiceTranscript["']/i,
    /class\s*=\s*["'][^"']*\bcomposer-wrap\b/i
  ];
  return /Bard\s*AI/i.test(html) && markers.filter(marker => marker.test(html)).length >= 3;
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
  const selfPreview = Boolean(preview && isBardApplicationMarkup(preview.source));
  const messageText = selfPreview || preview ? String(item.text).replace(preview.block, '').trim() : item.text;
  addTextParts(bubble, messageText);
  if (preview && !selfPreview) { row.classList.add('has-preview'); renderCodePreview(bubble, preview); }
  if (selfPreview) {
    const warning = document.createElement('p');
    warning.className = 'preview-suppressed';
    warning.textContent = 'Diese Vorschau wurde ausgeblendet, weil ihr HTML Bard AI selbst nachbildet.';
    bubble.append(warning);
  }
  if (item.sources) renderSources(bubble, item.sources);
  if (item.searchSuggestion) renderSearchSuggestion(bubble, item.searchSuggestion);
  if (item.image) {
    const image = document.createElement('img');
    image.className = 'generated'; image.alt = item.image.alt || 'Von Bard AI generiertes Bild';
    image.src = `data:${item.image.mimeType};base64,${item.image.data}`;
    image.addEventListener('load', scrollConversationToBottom, { once: true });
    bubble.append(image);
  }
  row.append(avatar, bubble); $('#messages').append(row);
  if (scroll) scrollConversationToBottom();
  return row;
}
function saveUserName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!name) return false;
  state.name = name;
  void persistProfile().catch(() => notice('Der Name bleibt im aktuellen Gespräch erhalten, konnte aber nicht dauerhaft gespeichert werden.', true));
  $('#userName').value = state.name;
  renderMemory();
  $('#nameForm').classList.add('hidden');
  $('#welcome').classList.remove('needs-name');
  renderMessages();
  return true;
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
    remove.addEventListener('click', () => { state.name = ''; writeStored('bard_user_name', ''); void persistProfile().catch(() => {}); $('#userName').value = ''; $('#nameForm').classList.remove('hidden'); $('#welcome').classList.add('needs-name'); renderMemory(); renderMessages(); });
    profile.append(label, remove); list.append(profile);
  }
  for (const [index, fact] of state.memory.entries()) {
    const item = document.createElement('li');
    const text = document.createElement('span'); text.textContent = fact;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'memory-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Erinnerung entfernen');
    remove.addEventListener('click', () => { state.memory.splice(index, 1); void persistProfile().catch(() => {}); renderMemory(); });
    item.append(text, remove); list.append(item);
  }
}
function remember(value) {
  const fact = String(value || '').replace(/[\s.!?]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
  if (!fact || /\b(passw(?:ort|ord)|api[- ]?key|zugangsdaten|token|secret|cvv|pin)\b/i.test(fact)) return false;
  const key = fact.toLocaleLowerCase('de').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const existing = state.memory.findIndex(item => item.toLocaleLowerCase('de').replace(/[^\p{L}\p{N}]+/gu, ' ').trim() === key);
  if (existing >= 0) state.memory.splice(existing, 1);
  state.memory = [...state.memory, fact].slice(-24);
  void persistProfile().catch(() => notice('Das Memory konnte nicht dauerhaft gespeichert werden.', true)); renderMemory();
  return true;
}
function assistantAskedForName() {
  const previous = [...state.messages].reverse().find(item => item.role === 'assistant');
  return Boolean(previous && /wie\s+(?:darf|soll|kann|möchtest)\s+ich\s+dich\s+nennen|wie\s+heißt\s+du|wie\s+lautet\s+dein\s+name|was\s+ist\s+dein\s+name|welchen\s+namen\s+(?:soll|darf)\s+ich\s+(?:dir\s+geben|verwenden)|wie\s+möchtest\s+du\s+angesprochen\s+werden|darf\s+ich\s+deinen\s+namen\s+wissen/iu.test(previous.text || ''));
}
function captureConversationMemory(text) {
  const normalized = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  let changed = false;
  const nameMatch = normalized.match(/(?:\bich heiße|\bich heisse|\bmein name ist|\bmein vorname ist|\bnenn mich|\bdu kannst mich nennen)\s+([\p{L}][\p{L}\p{M}'’-]{0,39})/iu);
  const invalidNames = new Set(['müde','muede','hungrig','durstig','krank','glücklich','gluecklich','traurig','bereit','gerade','ein','eine','am','im','nicht','nur','auch','heute','hier']);
  const promptedName = !state.name && (assistantAskedForName() || !$('#nameForm').classList.contains('hidden')) ? normalized.match(/^ich bin\s+([\p{L}][\p{L}\p{M}'’-]{0,39})[.!]?$/iu) : null;
  const candidateName = nameMatch?.[1] || promptedName?.[1];
  if (candidateName && !invalidNames.has(candidateName.toLocaleLowerCase('de')) && candidateName !== state.name) {
    saveUserName(candidateName); changed = true;
  } else if (!state.name && (assistantAskedForName() || !$('#nameForm').classList.contains('hidden'))) {
    const shortAnswer = normalized.match(/^([\p{L}][\p{L}\p{M}'’-]{0,39}(?:\s+[\p{L}][\p{L}\p{M}'’-]{0,39})?)[.!]?$/iu);
    const filler = new Set(['ja','nein','okay','ok','klar','hi','hallo','hey','test','bro','danke','ich','du','mich','dich','weiß','weiss']);
    if (shortAnswer && shortAnswer[1].split(/\s+/).every(part => !filler.has(part.toLocaleLowerCase('de')))) {
      saveUserName(shortAnswer[1]); changed = true;
    }
  }
  const explicit = normalized.match(/(?:\bmerk(?:e)? dir|\bspeicher(?:e)? dir|\bdenk dran|\bmerke bitte|\bbitte nicht vergessen)[\s,:-]+(?:dass\s+)?(.+)/iu);
  if (explicit?.[1]) changed = remember(explicit[1]) || changed;
  const stableFactPatterns = [
    /\b(ich mag|ich liebe|ich bevorzuge|ich interessiere mich für|ich arbeite als|ich arbeite an|ich lerne gerade|ich studiere|ich spreche|ich nutze|ich verwende|ich spiele gern|ich spiele gerne|ich mache gern|ich mache gerne|ich fahre gern|ich fahre gerne|ich gehe gern|ich gehe gerne|ich sammle|ich entwickle|ich baue|mein ziel ist|mir ist wichtig|i like|i love|i prefer|i work as|i am learning|i study)\s+([^.!?\n]{2,140})/iu,
    /\b(mein(?:e|en)? lieblings(?:farbe|film|serie|spiel|musik|band|buch|essen|getränk|sport|verein)? ist)\s+([^.!?\n]{2,100})/iu,
    /\b(ich habe (?:einen hund|eine katze|ein haustier|einen bruder|eine schwester|kinder))(?:\s+(?:namens|mit namen)\s+([^.!?\n]{2,80}))?/iu
  ];
  const capturedFacts = new Set();
  for (const pattern of stableFactPatterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const fact = [match[1], match[2]].filter(Boolean).join(' ');
    if (fact && !capturedFacts.has(fact.toLocaleLowerCase('de'))) {
      capturedFacts.add(fact.toLocaleLowerCase('de'));
      changed = remember(fact) || changed;
    }
  }
  return changed;
}
function appendAssistantReply(text) {
  const message = { id: crypto.randomUUID(), role: 'assistant', text: safeText(text), created: Date.now() };
  state.messages.push(message);
  renderMessage(message);
  void persistMessages().catch(() => {});
}
function renderMessages() {
  const rows = $('#messages'); rows.replaceChildren();
  for (const item of state.messages) renderMessage(item, false);
  scrollConversationToBottom();
}


function typing(show) {
  let row = $('#typingRow');
  if (show && !row) {
    row = document.createElement('div'); row.id = 'typingRow'; row.className = 'message assistant';
    const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = '✦';
    const bubble = document.createElement('div'); bubble.className = 'bubble typing'; bubble.textContent = 'Bard denkt nach …';
    row.append(avatar, bubble); $('#messages').append(row);
  } else if (!show) row?.remove();
  if (show) scrollConversationToBottom();
}
function requestsCodePreview(text) {
  const value = String(text || '').toLocaleLowerCase('de');
  return /\b(html|css|javascript|js|svg|canvas|3d|cube|wireframe)\b|webseite|website|landing[- ]?page|prototyp|grafik|diagramm|visualisierung|animation|vorschau|dashboard|würfel|drahtmodell|drahtgitter|rotier|drehend|drehen|mach mir (?:ein|eine) (?:bild|grafik|animation|seite|webseite)/.test(value);
}
function playLiveTextAudio(chunks, context) {
  if (!context || context.state !== 'running') { context?.close().catch(() => {}); return; }
  let remaining = 0, nextTime = context.currentTime + 0.04;
  for (const chunk of chunks) {
    try {
      const samples = decodePcm16(chunk);
      if (!samples.length) continue;
      const buffer = context.createBuffer(1, samples.length, 24000);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      const gain = context.createGain();
      gain.gain.value = 0.94;
      source.connect(gain); gain.connect(context.destination);
      const start = nextTime;
      nextTime += buffer.duration;
      remaining++;
      source.onended = () => { if (--remaining === 0) context.close().catch(() => {}); };
      source.start(start);
    } catch {}
  }
  if (!remaining) context.close().catch(() => {});
}
function liveTextExchange(session, prompt, audioContext, onUpdate = () => {}, imageAttachment = null) {
  return new Promise((resolve, reject) => {
    const socketUrl = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=' + encodeURIComponent(session.token);
    const socket = new WebSocket(socketUrl);
    socket.binaryType = 'arraybuffer';
    let settled = false, setupReady = false, submitted = false;
    let answerText = '', previewHtml = '', searchSuggestion = '', toolUsed = false, lastPublishedText = '';
    const audio = [], sources = [];
    const timeout = setTimeout(() => finish(reject, new Error('Die Live-Textantwort dauerte zu lange.')), 180000);
    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { socket.close(1000, 'Textantwort abgeschlossen'); } catch {}
      callback(value);
    }
    function sendPrompt() {
      if (submitted || !setupReady) return;
      submitted = true;
      try {
        const chunks = [];
        let chunk = '';
        for (const character of prompt) {
          chunk += character;
          if (chunk.length >= 8000) { chunks.push(chunk); chunk = ''; }
        }
        if (chunk || !chunks.length) chunks.push(chunk);
        chunks.forEach((part, index) => socket.send(JSON.stringify({
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: part }, ...(index === 0 && imageAttachment ? [{ inlineData: imageAttachment }] : [])] }],
            turnComplete: index === chunks.length - 1
          }
        })));
      } catch { finish(reject, new Error('Die Textnachricht konnte nicht an den Live-Kanal gesendet werden.')); }
    }
    socket.onopen = () => {
      try { socket.send(JSON.stringify({ setup: { model: session.model, ...(session.config || {}) } })); }
      catch { finish(reject, new Error('Die Live-Konfiguration konnte nicht gesendet werden.')); }
    };
    socket.onmessage = async event => {
      let message;
      try {
        const data = event.data;
        const raw = typeof data === 'string' ? data : data instanceof Blob ? await data.text()
          : data instanceof ArrayBuffer ? new TextDecoder().decode(data)
          : ArrayBuffer.isView(data) ? new TextDecoder().decode(data) : '';
        if (!raw) throw new Error();
        message = JSON.parse(raw);
      } catch {
        finish(reject, new Error('Die Live-Antwort hatte ein ungültiges Format.'));
        return;
      }
      if (message.setupComplete || message.setup_complete) {
        setupReady = true;
        sendPrompt();
        return;
      }
      if (message.error?.message) {
        const detail = String(message.error.message).slice(0, 600);
        const error = new Error(detail);
        if (/invalid.+payload|unknown name|cannot find field|invalid argument/i.test(detail)) error.liveFailure = 'request';
        if (/safety|blocked|content filter|prohibited/i.test(detail)) error.liveFailure = 'blocked';
        finish(reject, error);
        return;
      }
      const toolCall = message.toolCall || message.tool_call;
      const calls = toolCall?.functionCalls || toolCall?.function_calls || [];
      if (calls.length && socket.readyState === WebSocket.OPEN) {
        toolUsed = true;
        const functionResponses = [];
        for (const call of calls) {
          const name = String(call.name || ''), args = call.args || {};
          if (name === 'show_web_preview') {
            const html = typeof args.html === 'string' ? args.html : '';
            const fence = String.fromCharCode(96).repeat(3);
            const preview = html.length <= 100_000 ? previewMarkup(fence + 'html\n' + html + '\n' + fence) : null;
            if (preview) {
              previewHtml = preview.source;
              functionResponses.push({ id: call.id, name, response: { result: 'Die Vorschau wird zusammen mit der Chat-Antwort angezeigt.' } });
            } else functionResponses.push({ id: call.id, name, response: { error: 'HTML fehlt, ist ungültig oder größer als 10.000 Zeichen.' } });
          } else functionResponses.push({ id: call.id, name, response: { error: 'Dieses Tool ist in der PWA nicht verfügbar.' } });
        }
        try { socket.send(JSON.stringify({ toolResponse: { functionResponses } })); }
        catch { finish(reject, new Error('Die Live-Vorschau konnte nicht bestätigt werden.')); return; }
      }
      const content = message.serverContent || message.server_content;
      if (!content) return;
      const output = content.outputTranscription?.text || content.output_transcription?.text;
      if (output) answerText = joinTranscriptText(answerText, output);
      const parts = content.modelTurn?.parts || content.model_turn?.parts || [];
      for (const part of parts) {
        const inline = part.inlineData || part.inline_data;
        if (inline?.data) audio.push(inline.data);
        if (typeof part.text === 'string' && part.thought !== true && part.thought !== 'true') answerText = joinTranscriptText(answerText, part.text);
      }
      const grounding = content.groundingMetadata || content.grounding_metadata;
      if (grounding) {
        const chunks = grounding.groundingChunks || grounding.grounding_chunks || [];
        for (const chunk of chunks) {
          const source = chunk.web || {};
          if (source.title && /^https:\/\//i.test(String(source.uri || ''))) sources.push({ title: String(source.title).slice(0, 180), url: String(source.uri) });
        }
        searchSuggestion = String(grounding.searchEntryPoint?.renderedContent || grounding.search_entry_point?.rendered_content || '').slice(0, 24000);
      }
      if (answerText !== lastPublishedText) {
        lastPublishedText = answerText;
        try { onUpdate(answerText); } catch {}
      }
      const generationComplete = content.generationComplete || content.generation_complete;
      const turnComplete = content.turnComplete || content.turn_complete;
      // Show plain answers as soon as generation ends; turnComplete may wait for audio playback.
      if ((generationComplete && !toolUsed) || turnComplete) {
        let text = answerText.trim();
        if (previewHtml) text += (text ? '\n\n' : '') + String.fromCharCode(96).repeat(3) + 'html\n' + previewHtml + '\n' + String.fromCharCode(96).repeat(3);
        if (!text) { finish(reject, new Error('Der Live-Kanal hat keine Textantwort geliefert.')); return; }
        finish(resolve, { text, audio, audioContext, sources: sources.slice(0, 8), searchSuggestion });
      }
    };
    socket.onerror = () => finish(reject, new Error('Die Live-Verbindung für den Text-Chat ist fehlgeschlagen.'));
    socket.onclose = event => {
      if (!settled) {
        const error = new Error(event.reason || 'Der Live-Kanal wurde vor der Antwort geschlossen.');
        error.liveCloseCode = Number(event.code) || 0;
        finish(reject, error);
      }
    };
  });
}
const LIVE_MODEL_ORDER = [
  'models/gemini-3.8-live',
  'models/gemini-3.1-flash-live-preview',
  'models/gemini-2.5-flash-native-audio-preview-12-2025'
];
function readLiveModelStats() {
  try {
    const value = JSON.parse(readStored('bard_live_model_stats') || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function liveModelOrder() {
  const stats = readLiveModelStats();
  const measured = LIVE_MODEL_ORDER.map(model => {
    const row = stats[model];
    const times = Array.isArray(row?.times) ? row.times.filter(value => Number.isFinite(value) && value > 0).slice(-5) : [];
    if (!times.length) return null;
    const average = times.reduce((sum, value) => sum + value, 0) / times.length;
    const failures = Math.min(20, Math.max(0, Number(row.failures) || 0));
    return { model, score: average * (1 + failures / times.length) };
  }).filter(Boolean).sort((left, right) => left.score - right.score).map(row => row.model);
  return [...measured, ...LIVE_MODEL_ORDER.filter(model => !measured.includes(model))];
}
function recordLiveModelResult(model, elapsed, succeeded) {
  if (!LIVE_MODEL_ORDER.includes(model)) return;
  const stats = readLiveModelStats();
  const row = stats[model] && typeof stats[model] === 'object' ? stats[model] : { times: [], failures: 0 };
  row.times = Array.isArray(row.times) ? row.times.filter(value => Number.isFinite(value) && value > 0).slice(-5) : [];
  row.failures = Math.min(20, Math.max(0, Number(row.failures) || 0));
  if (succeeded) row.times.push(Math.max(1, Math.round(elapsed)));
  else row.failures += 1;
  stats[model] = row;
  writeStored('bard_live_model_stats', JSON.stringify(stats));
}
async function requestLiveTextReply(text, codePreview = false, onUpdate = () => {}, imageAttachment = null) {
  let audioContext;
  try {
    audioContext = new AudioContext({ latencyHint: 'interactive' });
    void audioContext.resume().catch(() => {});
  } catch {}
  const livePrompt = codePreview
    ? text + '\n\nErstelle die angeforderte Visualisierung als eigenständige, sofort lauffähige HTML-Vorschau. Rufe dafür show_web_preview mit vollständigem HTML auf. Falls der Tool-Aufruf nicht verfügbar ist, gib dasselbe Dokument in einem ```html-Codeblock aus, damit die App es direkt als Vorschau anzeigen kann. Keine externen Dateien oder Netzwerkzugriffe. Für 3D-Objekte: verwende eine sichtbare, kontrastreiche CSS-3D- oder Canvas-Darstellung mit Bewegung, Startposition und 2D/SVG-Fallback; setze eine passende Perspektive, Größe und Tiefe, damit sie auf kleinen und großen Displays sichtbar bleibt. Füge den mobilen Viewport hinzu. Gib außerhalb der Vorschau höchstens eine kurze Erklärung.'
    : text + '\n\nAntworte vollständig genug, dass die Frage beantwortet ist. Vermeide unnötige Wiederholungen und gib keine internen Gedanken aus.';
  const fullContext = buildLiveContext().slice(0, -1);
  // Long prompts get compact recent context to keep their input-token footprint lower.
  const requestContext = text.length > 1200
    ? fullContext.slice(-2).map(item => ({ ...item, text: String(item.text || '').slice(-400) }))
    : fullContext;
  const tokenRequest = {
    responseMode: 'creative',
    userName: state.name,
    memory: state.memory,
    voiceName: state.voice.voiceName || 'Puck',
    context: requestContext
  };
  const candidates = liveModelOrder().map(model => ({ ...tokenRequest, model }));
  let lastError;
  for (const candidate of candidates) {
    const startedAt = performance.now();
    try {
      const session = await requestWorker('/api/live-token', candidate);
      if (!session.token || !session.model || !session.config) throw new Error('Der Live-Server hat keine sichere Sitzung bereitgestellt.');
      const result = await liveTextExchange(session, livePrompt, audioContext, onUpdate, imageAttachment);
      recordLiveModelResult(session.model, performance.now() - startedAt, true);
      return result;
    } catch (error) {
      recordLiveModelResult(candidate.model, performance.now() - startedAt, false);
      lastError = error;
      if (error?.failureKind === 'live-burst' || isProviderQuotaError(error)) break;
    }
  }
  audioContext?.close().catch(() => {});
  throw lastError || new Error('Der Live-Text-Chat ist gerade nicht erreichbar.');
}

async function prepareAttachment(file, question) {
  if (/^image\/(?:jpeg|png|webp|gif)$/i.test(file.type)) {
    if (file.size > 8 * 1024 * 1024) throw new Error('Das Bild ist zu groß. Bitte wähle eine Datei unter 8 MB.');
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Das Bild konnte nicht gelesen werden.'));
      reader.readAsDataURL(file);
    });
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([\s\S]+)$/i);
    if (!match) throw new Error('Dieses Bildformat kann hier nicht verarbeitet werden.');
    return { text: `${question || 'Bitte analysiere das angehängte Bild.'}\n\nAngehängtes Bild: ${file.name}. Beschreibe nur, was im Bild tatsächlich erkennbar ist.`, image: { mimeType: match[1], data: match[2] } };
  }
  const supportedText = /\.(?:txt|md|csv|json|html|css|js|xml|log)$/i.test(file.name) || /^(?:text\/|application\/(?:json|xml))/i.test(file.type);
  if (!supportedText) throw new Error('Bitte wähle ein Foto oder eine Textdatei (TXT, MD, CSV, JSON, HTML, CSS, JS oder XML).');
  if (file.size > 500_000) throw new Error('Die Textdatei ist zu groß. Bitte wähle eine Datei unter 500 KB.');
  const content = (await file.text()).replace(/^\uFEFF/, '').slice(0, 30_000);
  if (!content.trim()) throw new Error('Die ausgewählte Datei enthält keinen lesbaren Text.');
  return { text: `${question || `Bitte analysiere die angehängte Datei „${file.name}“.`}\n\n--- Inhalt von ${file.name} ---\n${content}\n--- Ende der Datei ---`, image: null };
}
function renderAttachmentPreview() {
  const host = $('#attachmentPreview');
  host.replaceChildren();
  const file = state.pendingAttachment;
  host.hidden = !file;
  if (!file) { requestAnimationFrame(updateScrollToBottomButton); return; }
  const label = document.createElement('span');
  label.textContent = `📎 ${file.name}`;
  const remove = document.createElement('button');
  remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Anhang entfernen');
  remove.addEventListener('click', () => { state.pendingAttachment = null; $('#imageAttachmentInput').value = ''; $('#textAttachmentInput').value = ''; renderAttachmentPreview(); });
  host.append(label, remove);
  requestAnimationFrame(updateScrollToBottomButton);
}
function toggleAttachmentMenu() {
  const menu = $('#attachmentMenu');
  menu.hidden = !menu.hidden;
  $('#imageButton').setAttribute('aria-expanded', String(!menu.hidden));
}
async function submitPrompt(text = $('#prompt').value.trim()) {
  const file = state.pendingAttachment;
  if ((!text && !file) || state.busy) return;
  let requestText = text, imageAttachment = null;
  if (file) {
    try {
      const prepared = await prepareAttachment(file, text);
      requestText = prepared.text; imageAttachment = prepared.image;
    } catch (error) { notice(error.message || 'Der Anhang konnte nicht gelesen werden.', true); return; }
  }
  const displayText = text || (file ? `Bitte analysiere den Anhang: ${file.name}` : '');
  captureConversationMemory(text);
  const userMessage = { id: crypto.randomUUID(), role: 'user', text: safeText(displayText), created: Date.now() };
  state.messages.push(userMessage); renderMessage(userMessage); void persistMessages().catch(() => {});
  state.pendingAttachment = null; $('#imageAttachmentInput').value = ''; $('#textAttachmentInput').value = ''; renderAttachmentPreview(); $('#attachmentMenu').hidden = true;
  $('#prompt').value = ''; resizePrompt(); state.busy = true; typing(true); setConnection('busy', 'Denkt nach');
  try {
    if (state.imageMode && !file) {
      const result = await requestWorker('/api/image', { prompt: requestText, userName: state.name, memory: state.memory, context: buildLiveContext().slice(0, -1) });
      if (!result.image?.data) throw new Error('Der Bilddienst hat kein Bild zurückgegeben.');
      const answer = { id: crypto.randomUUID(), role: 'assistant', text: safeText(result.text || 'Hier ist dein Bild.'), image: { mimeType: result.image.mimeType || 'image/png', data: result.image.data }, created: Date.now() };
      state.messages.push(answer); renderMessage(answer); void persistMessages().catch(() => {});
    } else {
      const codePreview = requestsCodePreview(requestText);
      let result, draftRow = null;
      try {
        result = await requestLiveTextReply(requestText, codePreview, partialText => {
          if (!partialText) return;
          if (!draftRow) {
            draftRow = renderMessage({ role: 'assistant', text: partialText }, false);
            draftRow.classList.add('streaming');
          } else {
            const bubble = draftRow.querySelector('.bubble');
            if (bubble) bubble.textContent = partialText;
          }
          scrollConversationToBottom();
        }, imageAttachment);
      } catch (liveError) {
        draftRow?.remove();
        if (file || displayText.length <= 1200 || !isProviderQuotaError(liveError)) throw liveError;
        result = await requestWorker('/api/chat', {
          messages: [{ role: 'user', text: displayText }],
          userName: state.name,
          memory: state.memory,
          context: buildLiveContext().slice(0, -1)
        });
      }
      draftRow?.remove();
      const answer = { id: crypto.randomUUID(), role: 'assistant', text: safeText(result.text) || 'Ich habe keine Textantwort erhalten.', sources: Array.isArray(result.sources) ? result.sources : [], searchSuggestion: result.searchSuggestion || '', created: Date.now() };
      state.messages.push(answer); renderMessage(answer); void persistMessages().catch(() => {});
      if (Array.isArray(result.audio) && result.audio.length) playLiveTextAudio(result.audio, result.audioContext);
      else result.audioContext?.close().catch(() => {});
    }
    setConnection('online', 'Verbunden');
  } catch (error) {
    setConnection('offline', 'Kurz getrennt'); notice('');
    appendAssistantReply(friendlyFailure(error));
  } finally {
    state.imageMode = false; $('#imageButton').classList.remove('selected'); $('#prompt').placeholder = 'Frag Bard AI …';
    typing(false); state.busy = false;
  }
}
function resizePrompt() { const area = $('#prompt'); area.style.height = 'auto'; area.style.height = Math.min(area.scrollHeight, 180) + 'px'; requestAnimationFrame(updateScrollToBottomButton); }
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
function sendVoiceAudioSamples(samples, socket = state.voice.socket) {
  if (!samples?.length || !socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    const data = encodePcm16(samples);
    socket.send(JSON.stringify({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } }));
    return true;
  } catch { return false; }
}
function queueDeferredVoiceAudio(samples) {
  const voice = state.voice;
  if (!samples?.length) return;
  let total = 0;
  for (const sample of samples) total += sample * sample;
  const rms = Math.sqrt(total / samples.length);
  const copy = new Float32Array(samples);
  const queue = chunk => {
    voice.deferredInputAudio.push(chunk);
    voice.deferredInputSamples += chunk.length;
  };
  if (rms >= 0.006) {
    if (!voice.deferredInputSpeech) {
      for (const chunk of voice.deferredInputPreRoll) queue(chunk);
      voice.deferredInputPreRoll = [];
      voice.deferredInputSpeech = true;
    }
    queue(copy);
    voice.deferredInputQuietFrames = 0;
  } else if (voice.deferredInputSpeech) {
    queue(copy);
    voice.deferredInputQuietFrames++;
    if (voice.deferredInputQuietFrames >= 14) {
      voice.deferredInputSpeech = false;
      voice.deferredInputQuietFrames = 0;
      voice.deferredInputPreRoll = [];
    }
  } else {
    voice.deferredInputPreRoll.push(copy);
    if (voice.deferredInputPreRoll.length > 4) voice.deferredInputPreRoll.shift();
  }
  const maxSamples = 16000 * 20;
  while (voice.deferredInputSamples > maxSamples && voice.deferredInputAudio.length) {
    voice.deferredInputSamples -= voice.deferredInputAudio.shift().length;
  }
}
async function flushDeferredVoiceAudio() {
  const voice = state.voice;
  if (!voice.active || voice.flushingDeferredInput || !voice.deferredInputAudio.length) return;
  const socket = voice.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  voice.flushingDeferredInput = true;
  voiceState('thinking', 'Frage wird übernommen', 'Ich sende deine Zwischenfrage nach meiner Antwort.');
  try {
    while (voice.active && socket === voice.socket && socket.readyState === WebSocket.OPEN && voice.deferredInputAudio.length) {
      const samples = voice.deferredInputAudio.shift();
      voice.deferredInputSamples = Math.max(0, voice.deferredInputSamples - samples.length);
      if (!sendVoiceAudioSamples(samples, socket)) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(60, samples.length / 16000 * 1000)));
    }
  } finally {
    voice.flushingDeferredInput = false;
    if (!voice.active || socket !== voice.socket || socket.readyState !== WebSocket.OPEN) {
      voice.deferredInputAudio = [];
      voice.deferredInputSamples = 0;
    } else if (voice.deferredInputAudio.length) {
      void flushDeferredVoiceAudio();
    } else {
      voice.deferredInputSpeech = false;
      voice.deferredInputQuietFrames = 0;
      voice.deferredInputPreRoll = [];
      voiceState('listening', 'Ich höre zu', 'Du kannst jederzeit weitersprechen.');
    }
  }
}
function clearDeferredVoiceAudio() {
  const voice = state.voice;
  voice.deferredInputAudio = [];
  voice.deferredInputSamples = 0;
  voice.deferredInputSpeech = false;
  voice.deferredInputQuietFrames = 0;
  voice.deferredInputPreRoll = [];
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
      voice.outputActive = false;
      void flushDeferredVoiceAudio();
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
  state.voice.previewTranscriptEntry = null;
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
  scrollToBottom(transcript);
  // Keep the chat behind the live dialog pinned to its latest saved message too.
  scrollConversationToBottom();
}
function closeLivePreview() {
  const dialog = $('#livePreviewDialog');
  const frame = $('#livePreviewFrame');
  if (dialog?.open) dialog.close();
  if (frame) frame.src = 'about:blank';
  state.voice.pendingPreview = null;
}
function openLivePreview(title, preview) {
  const dialog = $('#livePreviewDialog');
  const frame = $('#livePreviewFrame');
  $('#livePreviewTitle').textContent = String(title || 'Neue Visualisierung').slice(0, 100);
  const previewUrl = new URL(`./preview.html?live=${Date.now()}`, document.baseURI).href;
  frame.addEventListener('load', () => {
    if (!dialog.open || frame.src !== previewUrl) return;
    frame.contentWindow?.postMessage({ type: 'bard-preview', html: preview.html }, '*');
  }, { once: true });
  if (!dialog.open) dialog.showModal();
  frame.src = previewUrl;
}
function showLiveCodePreview(title, preview) {
  openLivePreview(title, preview);
  const transcript = $('#voiceTranscript'); $('#voiceTranscriptEmpty')?.remove();
  let entry = state.voice.previewTranscriptEntry;
  if (!entry?.isConnected) {
    entry = document.createElement('article'); entry.className = 'voice-transcript-entry assistant voice-preview-entry';
    const speaker = document.createElement('span'); speaker.className = 'voice-transcript-speaker'; speaker.textContent = 'BARD AI';
    const label = document.createElement('p'); label.className = 'voice-transcript-text';
    entry.append(speaker, label); transcript.append(entry); state.voice.previewTranscriptEntry = entry;
  }
  entry.querySelector('.voice-transcript-text').textContent = `Vorschau geöffnet/aktualisiert · ${String(title || 'Neue Visualisierung').slice(0, 100)}`;
  while (transcript.querySelectorAll('.voice-transcript-entry').length > 36) transcript.querySelector('.voice-transcript-entry')?.remove();
  transcript.scrollTo({ top: transcript.scrollHeight, behavior: 'smooth' });
}
async function handleLiveToolCall(toolCall) {
  const calls = toolCall?.functionCalls || toolCall?.function_calls || []; const functionResponses = [];
  for (const call of calls) {
    const name = String(call.name || ''); const args = call.args || {};
    if (name === 'show_web_preview') {
      const html = typeof args.html === 'string' ? args.html : '';
      const title = String(args.title || 'Neue Visualisierung').slice(0, 100);
      const action = String(args.action || '').toLowerCase();
      const closeRequested = action === 'close' || (!html.trim() && /close|schlie|ausblend|hide/i.test(title));
      if (closeRequested) {
        closeLivePreview();
        if (state.voice.previewTranscriptEntry?.isConnected) state.voice.previewTranscriptEntry.querySelector('.voice-transcript-text').textContent = 'Vorschau geschlossen.';
        functionResponses.push({ id: call.id, name, response: { result: 'Die Live-Vorschau wurde geschlossen. Für eine neue Version rufe show_web_preview erneut mit einer vollständigen HTML-Datei auf.' } });
        continue;
      }
      const preview = html.length <= 10_000 ? previewMarkup('```html\n' + html + '\n```') : null;
      if (preview) {
        state.voice.pendingPreview = { title, html };
        showLiveCodePreview(title, preview);
        functionResponses.push({ id: call.id, name, response: { result: 'Die große Live-Vorschau wurde geöffnet oder aktualisiert. Für Änderungen rufe show_web_preview erneut auf; zum Schließen rufe es mit Titel „close“ und leerem HTML auf.' } });
      } else functionResponses.push({ id: call.id, name, response: { error: 'HTML fehlt, ist ungültig oder größer als 10.000 Zeichen. Erzeuge eine kleinere vollständige Vorschau.' } });
    } else functionResponses.push({ id: call.id, name, response: { error: 'Dieses Tool ist in der PWA nicht verfügbar.' } });
  }
  if (functionResponses.length && state.voice.socket?.readyState === WebSocket.OPEN) state.voice.socket.send(JSON.stringify({ toolResponse: { functionResponses } }));
}
function handleVoiceMessage(message) {
  const voice = state.voice;
  if (message.error?.message) { voiceFailure(String(message.error.message).slice(0, 300)); return; }
  const toolCall = message.toolCall || message.tool_call;
  if (toolCall) void handleLiveToolCall(toolCall).catch(() => voiceFailure('Die Live-Vorschau konnte nicht angezeigt werden.'));
  const content = message.serverContent || message.server_content;
  if (!content) return;
  const input = content.inputTranscription?.text || content.input_transcription?.text;
  const output = content.outputTranscription?.text || content.output_transcription?.text;
  const grounding = content.groundingMetadata || content.grounding_metadata || message.groundingMetadata || message.grounding_metadata;
  const suggestion = grounding?.searchEntryPoint?.renderedContent || grounding?.search_entry_point?.rendered_content;
  if (suggestion) renderSearchSuggestion($('#voiceTranscript'), suggestion, true);
  if (input) {
    appendCaption('user', input);
    if (!state.name && assistantAskedForName()) {
      const shortName = state.voice.turnUser.trim().match(/^([\p{L}][\p{L}\p{M}'’-]{0,39}(?:\s+[\p{L}][\p{L}\p{M}'’-]{0,39})?)[.!]?$/iu);
      if (shortName) captureConversationMemory(shortName[1]);
    }
  }
  if (output) { voice.outputActive = true; appendCaption('assistant', output); }
  if (content.interrupted) {
    stopVoicePlayback(); voice.pendingTurnComplete = false; voice.outputActive = false;
    voiceState('listening', 'Ich höre zu', 'Sag einfach weiter — ich bin bei dir.');
    void flushDeferredVoiceAudio();
  }
  const parts = content.modelTurn?.parts || content.model_turn?.parts || [];
  for (const part of parts) {
    const inline = part.inlineData || part.inline_data;
    if (inline?.data) {
      voice.outputActive = true;
      voiceState('speaking', 'Bard AI spricht', 'Sprich ruhig weiter — ich höre deine Frage und antworte danach.');
      playVoiceAudio(inline.data);
    }
  }
  if (content.turnComplete || content.turn_complete) {
    void saveVoiceTurn().catch(() => notice('Das Sprachgespräch konnte lokal nicht gespeichert werden.', true));
    voice.pendingTurnComplete = true;
    if (!voice.sources.size) {
      voice.pendingTurnComplete = false;
      voice.outputActive = false;
      void flushDeferredVoiceAudio();
    }
  } else if ((content.inputTranscription || content.input_transcription) && !parts.length) {
    voiceState('thinking', 'Ich denke nach', 'Ich habe dich gehört und formuliere eine Antwort.');
  }
}
async function startVoiceCapture() {
  const voice = state.voice, ctx = voice.audioContext;
  if (!voice.stream || !ctx || !ctx.audioWorklet) throw new Error('Dieser Browser unterstützt den Live-Audiomodus nicht. Bitte aktualisiere deinen Browser.');
  const workletUrl = new URL('pcm-capture.js', import.meta.url).href;
  await ctx.audioWorklet.addModule(workletUrl);
  const source = ctx.createMediaStreamSource(voice.stream);
  const processor = new AudioWorkletNode(ctx, 'bard-pcm-capture');
  const silent = ctx.createGain(); silent.gain.value = 0;
  processor.port.onmessage = event => {
    if (!state.voice.active || state.voice.muted || !voice.socket || voice.socket.readyState !== WebSocket.OPEN) return;
    const samples = new Float32Array(event.data);
    if (voice.outputActive || voice.pendingTurnComplete || voice.sources.size || voice.flushingDeferredInput) {
      queueDeferredVoiceAudio(samples);
      return;
    }
    voice.deferredInputSpeech = false;
    voice.deferredInputQuietFrames = 0;
    voice.deferredInputPreRoll = [];
    sendVoiceAudioSamples(samples, voice.socket);
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
async function sendLiveVisualFrame() {
  const voice = state.voice, video = $('#voiceVideoPreview'), socket = voice.socket;
  if (voice.visualBusy || !voice.active || !voice.visualStream || !video?.videoWidth || !socket || socket.readyState !== WebSocket.OPEN) return;
  voice.visualBusy = true;
  try {
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d', { alpha: false });
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', 0.62).split(',')[1];
    if (data && voice.socket === socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ realtimeInput: { video: { data, mimeType: 'image/jpeg' } } }));
    }
  } catch {
    $('#visualCaptureStatus').textContent = 'Das aktuelle Bild konnte nicht übertragen werden.';
  } finally { voice.visualBusy = false; }
}
function updateVisualCaptureControls() {
  const voice = state.voice, camera = $('#cameraToggle'), screen = $('#screenToggle'), select = $('#cameraSelect');
  const ready = Boolean(voice.active && voice.isReady);
  camera.disabled = !ready; screen.disabled = !ready;
  select.disabled = !ready || voice.visualType === 'screen';
  camera.setAttribute('aria-pressed', String(voice.visualType === 'camera'));
  screen.setAttribute('aria-pressed', String(voice.visualType === 'screen'));
  camera.lastElementChild.textContent = voice.visualType === 'camera' ? 'Kamera stoppen' : 'Kamera';
  screen.lastElementChild.textContent = voice.visualType === 'screen' ? 'Teilen stoppen' : 'Bildschirm teilen';
  const preview = $('#voiceVideoPreview');
  preview.classList.toggle('hidden', !voice.visualType);
  preview.setAttribute('aria-label', voice.visualType === 'screen' ? 'Vorschau des geteilten Bildschirms' : 'Kameravorschau');
  $('#visualCaptureStatus').textContent = voice.visualType === 'camera'
    ? 'Kamera aktiv · Bilder werden höchstens einmal pro Sekunde übertragen.'
    : voice.visualType === 'screen'
      ? 'Bildschirmfreigabe aktiv · Bilder werden höchstens einmal pro Sekunde übertragen.'
      : 'Kamera und Bildschirm werden erst nach deiner Freigabe übertragen. Beim Wechsel zum Homescreen kann der Browser die Verbindung anhalten.';
}
function stopLiveVisualCapture() {
  const voice = state.voice;
  if (voice.visualTimer) clearInterval(voice.visualTimer);
  voice.visualTimer = null;
  const stream = voice.visualStream;
  voice.visualStream = null; voice.visualType = '';
  for (const track of stream?.getTracks?.() || []) { track.onended = null; track.stop(); }
  const preview = $('#voiceVideoPreview');
  if (preview) preview.srcObject = null;
  if ($('#cameraToggle')) updateVisualCaptureControls();
}
async function listLiveCameras() {
  const select = $('#cameraSelect'), previous = select.value;
  const devices = await navigator.mediaDevices.enumerateDevices();
  select.replaceChildren();
  for (const [value, label] of [['auto','Automatische Kamera'],['facing:user','Vorderkamera / Selfie'],['facing:environment','Rückkamera']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option);
  }
  devices.filter(device => device.kind === 'videoinput').forEach((device, index) => {
    const option = document.createElement('option'); option.value = 'device:' + device.deviceId;
    option.textContent = device.label || 'Kamera ' + (index + 1); select.append(option);
  });
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
}
async function startLiveVisualCapture(type) {
  const voice = state.voice;
  if (!voice.active || !voice.isReady || !voice.socket || voice.socket.readyState !== WebSocket.OPEN) {
    $('#visualCaptureStatus').textContent = 'Starte zuerst ein Live-Gespräch.'; return;
  }
  if (voice.visualType === type) { stopLiveVisualCapture(); return; }
  stopLiveVisualCapture();
  try {
    if (!navigator.mediaDevices) throw new Error('Dieser Browser bietet keinen Medienzugriff.');
    let stream;
    if (type === 'screen') {
      if (!navigator.mediaDevices.getDisplayMedia) throw new Error('Bildschirmfreigabe wird von diesem Browser nicht unterstützt.');
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 1, max: 1 } }, audio: false });
    } else {
      if (!navigator.mediaDevices.getUserMedia) throw new Error('Kamerazugriff wird von diesem Browser nicht unterstützt.');
      const selected = $('#cameraSelect').value;
      const video = selected.startsWith('facing:')
        ? { facingMode: { ideal: selected.slice(7) }, frameRate: { ideal: 1, max: 1 } }
        : selected.startsWith('device:')
          ? { deviceId: { exact: selected.slice(7) }, frameRate: { ideal: 1, max: 1 } }
          : { frameRate: { ideal: 1, max: 1 } };
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      await listLiveCameras();
    }
    voice.visualStream = stream; voice.visualType = type;
    const preview = $('#voiceVideoPreview'); preview.srcObject = stream; await preview.play();
    const track = stream.getVideoTracks()[0];
    track.addEventListener('ended', () => { if (voice.visualStream === stream) stopLiveVisualCapture(); }, { once: true });
    updateVisualCaptureControls(); await sendLiveVisualFrame();
    voice.visualTimer = setInterval(() => void sendLiveVisualFrame(), 1100);
  } catch (error) {
    stopLiveVisualCapture();
    $('#visualCaptureStatus').textContent = error?.name === 'NotAllowedError'
      ? 'Freigabe abgelehnt. Du kannst sie erneut starten und im Systemdialog erlauben.'
      : error?.name === 'NotFoundError' ? 'Keine passende Kamera oder Bildschirmquelle gefunden.'
      : String(error?.message || 'Freigabe konnte nicht gestartet werden.').slice(0, 180);
  }
}
function voiceFailure(message) {
  const voice = state.voice;
  if (!voice.active) return;
  voice.active = false; voice.isReady = false; voice.outputActive = false;
  clearDeferredVoiceAudio(); stopVoiceCapture(); stopVoicePlayback();
  try { voice.socket?.close(); } catch {}
  voice.audioContext?.close().catch(() => {}); voice.audioContext = null;
  voice.socket = null;
  const detail = message || 'Der Live-Sprachkanal konnte nicht gestartet werden.';
  const userMessage = friendlyFailure({ message: detail }, 'voice');
  voiceState('error', 'Verbindung unterbrochen', userMessage);
  if (voice.turnUser.trim() || voice.turnAssistant.trim()) {
    void saveVoiceTurn().catch(() => {}).finally(() => appendAssistantReply(userMessage));
  } else appendAssistantReply(userMessage);
  $('#voiceRetry').classList.remove('hidden');
  $('#voiceMute').classList.add('hidden');
}
async function saveVoiceTurn() {
  const voice = state.voice;
  const userText = safeText(voice.turnUser).trim();
  const assistantText = safeText(voice.turnAssistant).trim();
  const hadPreview = Boolean(voice.pendingPreview);
  voice.turnUser = ''; voice.turnAssistant = '';
  voice.transcriptUserEntry = null; voice.transcriptAssistantEntry = null;
  if (userText) captureConversationMemory(userText);
  const created = Date.now();
  if (userText) {
    const message = { id: crypto.randomUUID(), role: 'user', text: userText, created };
    state.messages.push(message); renderMessage(message);
  }
  if (assistantText || voice.pendingPreview) {
    const codeBlock = voice.pendingPreview ? '\n\n```html\n' + voice.pendingPreview.html + '\n```' : '';
    const message = { id: crypto.randomUUID(), role: 'assistant', text: safeText(assistantText.slice(0, 1500) + codeBlock), created: created + 1 };
    voice.pendingPreview = null;
    state.messages.push(message); renderMessage(message);
  }
  if (userText || assistantText || hadPreview) {
    $('#welcome').classList.add('compact');
    await persistMessages();
  }
}
function configureVoiceSession(result) {
  const config = { ...(result.config || {}) };
  const generationConfig = config.generationConfig || {};
  config.generationConfig = {
    ...generationConfig,
    speechConfig: {
      ...(generationConfig.speechConfig || {}),
      voiceConfig: {
        ...(generationConfig.speechConfig?.voiceConfig || {}),
        prebuiltVoiceConfig: { voiceName: state.voice.voiceName || 'Puck' }
      }
    }
  };
  return config;
}
function openLiveSocket(result, config, model = result.model) {
  const voice = state.voice;
  const socketUrl = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=' + encodeURIComponent(result.token);
  const socket = new WebSocket(socketUrl);
  socket.binaryType = 'arraybuffer';
  voice.socket = socket;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (callback === reject) {
        try { socket.close(1000, 'Live setup failed'); } catch {}
        if (voice.socket === socket) voice.socket = null;
      }
      callback(value);
    };
    const timeout = setTimeout(() => finish(reject, new Error('Der Live-Kanal hat innerhalb von 45 Sekunden keine Setup-Bestätigung gesendet.')), 45000);
    socket.onopen = () => {
      try { socket.send(JSON.stringify({ setup: { model, ...config } })); }
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
      if (message.setupComplete || message.setup_complete) { finish(resolve); return; }
      if (message.error?.message) {
        finish(reject, new Error(String(message.error.message).slice(0, 1000)));
        return;
      }
      handleVoiceMessage(message);
    };
    socket.onerror = () => finish(reject, new Error('Die Verbindung zu Bard AI Live ist fehlgeschlagen.'));
    socket.onclose = event => {
      if (!voice.active || voice.intentionalClose || settled) return;
      const detail = event.reason ? event.reason.slice(0, 1000) : 'Code ' + event.code;
      if (!voice.isReady) finish(reject, new Error('Der Live-Kanal wurde beim Verbindungsaufbau geschlossen (' + detail + ').'));
      else voiceFailure('Die Live-Verbindung wurde beendet (' + detail + '). Starte den Sprachmodus erneut.');
    };
  });
}
function isProviderQuotaError(error) {
  return error?.failureKind === 'provider-quota' || /resource[_ ]exhausted|current quota|quota exceeded|exceeded your current quota/i.test(error?.message || '');
}
async function startLiveVoice(keepDialog = false) {
  const voice = state.voice;
  if (voice.active) return;
  if (!keepDialog && !$('#voiceDialog').open) $('#voiceDialog').showModal();
  voice.active = true; voice.muted = false; voice.intentionalClose = false; voice.isReady = false; voice.pendingTurnComplete = false; voice.turnUser = ''; voice.turnAssistant = ''; voice.pendingPreview = null;
  voice.sources = new Set(); voice.nextPlayTime = 0; voice.outputActive = false; voice.flushingDeferredInput = false; clearDeferredVoiceAudio();
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
    const tokenRequest = {
      userName: state.name,
      memory: state.memory,
      voiceName: voice.voiceName,
      context: buildLiveContext()
    };
    const liveCandidates = liveModelOrder().map(model => ({ model, request: { ...tokenRequest, model } }));
    const connectionErrors = [];
    let connected = false;
    for (let index = 0; index < liveCandidates.length; index++) {
      if (!voice.active || voice.intentionalClose) break;
      const candidate = liveCandidates[index];
      const startedAt = performance.now();
      try {
        if (index > 0) voiceState('connecting', 'Verbinde erneut', 'Ich suche eine verfügbare Sprachverbindung.');
        const session = await requestWorker('/api/live-token', candidate.request);
        if (!session.token || !session.model || !session.config) throw new Error('Der Live-Server hat keine sichere Sitzung bereitgestellt.');
        await openLiveSocket(session, configureVoiceSession(session), session.model);
        recordLiveModelResult(session.model, performance.now() - startedAt, true);
        if (index > 0) notice('Bard AI hat eine alternative Verbindung hergestellt.', false);
        connected = true;
        break;
      } catch (error) {
        recordLiveModelResult(candidate.model, performance.now() - startedAt, false);
        connectionErrors.push(error);
      }
    }
    if (!connected && voice.active) throw connectionErrors.at(-1) || new Error('Der Sprachmodus konnte gerade nicht gestartet werden.');
    if (!voice.active) return;
    voice.isReady = true;
    updateVisualCaptureControls();
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
  closeLivePreview();
  voice.active = false; voice.intentionalClose = true; voice.isReady = false; voice.outputActive = false;
  clearDeferredVoiceAudio(); stopLiveVisualCapture(); stopVoiceCapture(); stopVoicePlayback();
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
if (!LIVE_VOICE_NAMES.has(readStored('bard_live_voice'))) writeStored('bard_live_voice', state.voice.voiceName);
localStorage.removeItem('bard_backend_url');
sessionStorage.removeItem('bard_session_token');
applyTheme(state.theme);
$('#themeToggle').addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark', true));
$('.conversation').addEventListener('scroll', updateScrollToBottomButton, { passive: true });
window.addEventListener('scroll', updateScrollToBottomButton, { passive: true });
window.addEventListener('resize', updateScrollToBottomButton, { passive: true });
$('#scrollToBottom').addEventListener('click', () => scrollConversationToBottom(true));
$('#chatsButton').addEventListener('click', async () => { await renderChatLibrary(); $('#chatDialog').showModal(); });
$('#newChatButton').addEventListener('click', async () => { if (state.busy) { notice('Warte, bis die Antwort fertig ist, bevor du einen neuen Chat startest.', true); return; } await persistMessages(); await createChatRecord(await dbPromise); $('#chatDialog').close(); notice('Neuer Chat erstellt.'); });
$('#closeChatDialog').addEventListener('click', () => $('#chatDialog').close());
$('#chatDialog').addEventListener('click', event => { if (event.target === $('#chatDialog')) $('#chatDialog').close(); });
$('#settingsButton').addEventListener('click', () => $('#settingsDialog').showModal());
$('#closeSettingsDialog').addEventListener('click', () => $('#settingsDialog').close());
$('#settingsDialog').addEventListener('click', event => { if (event.target === $('#settingsDialog')) $('#settingsDialog').close(); });
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
$('#imageButton').addEventListener('click', toggleAttachmentMenu);
function closeAttachmentMenu() { $('#attachmentMenu').hidden = true; $('#imageButton').setAttribute('aria-expanded', 'false'); }
$('#chooseImageButton').addEventListener('click', () => { closeAttachmentMenu(); $('#imageAttachmentInput').click(); });
$('#chooseTextAttachmentButton').addEventListener('click', () => { closeAttachmentMenu(); $('#textAttachmentInput').click(); });
$('#createImageButton').addEventListener('click', () => { closeAttachmentMenu(); toggleImageMode(); });
for (const inputId of ['imageAttachmentInput', 'textAttachmentInput']) {
  const input = document.getElementById(inputId);
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    state.pendingAttachment = file;
    $('#imageAttachmentInput').value = '';
    $('#textAttachmentInput').value = '';
    renderAttachmentPreview();
    notice('');
  });
}
document.addEventListener('click', event => {
  if (!$('#attachmentMenu').hidden && !$('#attachmentMenu').contains(event.target) && event.target !== $('#imageButton')) closeAttachmentMenu();
});
function finishDictationSetup(recognition, message = '') {
  if (state.dictation === recognition) state.dictation = null;
  state.dictationStopRequested = false;
  state.dictationStarted = false;
  $('#dictationButton').classList.remove('recording');
  $('#dictationButton').setAttribute('aria-pressed', 'false');
  notice(message);
}
function updateDictationText(text) {
  const live = state.dictationLive;
  if (!live || !text) return;
  live.transcript = joinTranscriptText(live.transcript, text);
  $('#prompt').value = [live.startingText, live.transcript].filter(Boolean).join(live.startingText ? ' ' : '');
  resizePrompt(); scrollConversationToBottom();
}
function stopLiveDictation(showNotice = false) {
  const live = state.dictationLive;
  if (!live) return;
  state.dictationLive = null;
  clearTimeout(live.finishTimer);
  clearTimeout(live.timeout);
  try { live.processor?.disconnect(); } catch {}
  try { live.sourceNode?.disconnect(); } catch {}
  try { live.silentGain?.disconnect(); } catch {}
  if (live.processor?.port) live.processor.port.onmessage = null;
  for (const track of live.stream?.getTracks?.() || []) track.stop();
  if (live.socket?.readyState === WebSocket.OPEN) {
    try { live.socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch {}
  }
  try { live.socket?.close(1000, 'Diktat beendet'); } catch {}
  live.audioContext?.close().catch(() => {});
  $('#dictationButton').classList.remove('recording', 'connecting');
  $('#dictationButton').setAttribute('aria-pressed', 'false');
  $('#dictationButton').setAttribute('aria-label', 'Sprache ins Textfeld diktieren');
  $('#dictationStatus').hidden = true;
  if (showNotice) notice(live.transcript ? 'Spracheingabe eingefügt.' : 'Keine Sprache erkannt. Tippe das Mikrofon an und sprich erneut.', !live.transcript);
  else notice('');
}
async function startLiveDictation() {
  const live = { startingText: $('#prompt').value.trim(), transcript: '', socket: null, stream: null, audioContext: null, processor: null, sourceNode: null, silentGain: null, finishTimer: null, timeout: null };
  state.dictationLive = live;
  $('#dictationButton').classList.add('connecting');
  $('#dictationButton').setAttribute('aria-pressed', 'true');
  $('#dictationButton').setAttribute('aria-label', 'Mikrofon verbindet');
  $('#dictationStatus').hidden = false;
  $('#dictationStatusText').textContent = 'Mikrofon verbindet …';
  notice('Verbinde sichere Live-Spracheingabe …');
  try {
    live.audioContext = new AudioContext({ latencyHint: 'interactive' });
    await live.audioContext.resume();
    live.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const session = await requestWorker('/api/live-token', {
      userName: state.name, memory: state.memory, voiceName: state.voice.voiceName || 'Puck',
      context: buildLiveContext(), model: liveModelOrder()[0]
    });
    if (state.dictationLive !== live) return;
    if (!session.token || !session.model || !session.config) throw new Error('Die Live-Spracheingabe konnte nicht eingerichtet werden.');
    const socket = new WebSocket('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=' + encodeURIComponent(session.token));
    live.socket = socket; socket.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      let ready = false;
      live.timeout = setTimeout(() => reject(new Error('Der Live-Sprachkanal antwortet nicht rechtzeitig.')), 25000);
      socket.onopen = () => {
        try { socket.send(JSON.stringify({ setup: { model: session.model, ...session.config } })); }
        catch { reject(new Error('Die Live-Spracheingabe konnte nicht gestartet werden.')); }
      };
      socket.onmessage = async event => {
        let message;
        try {
          const raw = typeof event.data === 'string' ? event.data : event.data instanceof Blob ? await event.data.text()
            : event.data instanceof ArrayBuffer ? new TextDecoder().decode(event.data) : '';
          message = JSON.parse(raw);
        } catch { return; }
        if (message.error?.message) { reject(new Error('Der Live-Sprachdienst ist gerade nicht erreichbar.')); return; }
        if (message.setupComplete || message.setup_complete) {
          if (ready) return; ready = true; clearTimeout(live.timeout);
          try {
            const url = new URL('pcm-capture.js', import.meta.url).href;
            void live.audioContext.audioWorklet.addModule(url).then(() => {
              if (state.dictationLive !== live || socket.readyState !== WebSocket.OPEN) return;
              const source = live.audioContext.createMediaStreamSource(live.stream);
              const processor = new AudioWorkletNode(live.audioContext, 'bard-pcm-capture');
              const silent = live.audioContext.createGain(); silent.gain.value = 0;
              processor.port.onmessage = chunk => {
                if (state.dictationLive !== live || socket.readyState !== WebSocket.OPEN) return;
                const samples = new Float32Array(chunk.data);
                sendVoiceAudioSamples(samples, socket);
              };
              source.connect(processor); processor.connect(silent); silent.connect(live.audioContext.destination);
              live.sourceNode = source; live.processor = processor; live.silentGain = silent;
              live.timeout = setTimeout(() => stopLiveDictation(true), 60000);
              $('#dictationButton').classList.remove('connecting');
              $('#dictationButton').classList.add('recording');
              $('#dictationButton').setAttribute('aria-label', 'Mikrofon aktiv – tippe zum Beenden');
              $('#dictationStatusText').textContent = 'Mikrofon aktiv · tippe zum Beenden';
              notice('Ich höre zu … Tippe das Mikrofon erneut, um das Diktat zu beenden.');
              resolve();
            }).catch(() => reject(new Error('Die Audioaufnahme wird von diesem Browser nicht unterstützt.')));
          } catch { reject(new Error('Die Audioaufnahme wird von diesem Browser nicht unterstützt.')); }
          return;
        }
        const content = message.serverContent || message.server_content;
        const input = content?.inputTranscription?.text || content?.input_transcription?.text;
        if (input) {
          updateDictationText(input);
          clearTimeout(live.finishTimer);
          live.finishTimer = setTimeout(() => stopLiveDictation(true), 1100);
        }
      };
      socket.onerror = () => reject(new Error('Die Live-Spracheingabe konnte keine Verbindung herstellen.'));
      socket.onclose = () => { if (!ready && state.dictationLive === live) reject(new Error('Der Live-Sprachkanal wurde geschlossen.')); };
    });
  } catch (error) {
    if (state.dictationLive === live) {
      stopLiveDictation(false);
      notice(error.message || 'Die Spracheingabe konnte nicht gestartet werden. Prüfe die Mikrofonberechtigung.', true);
    }
  }
}
function toggleDictation() {
  if (state.dictationLive) { stopLiveDictation(true); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    notice('Dieser Browser unterstützt die Live-Spracheingabe nicht. Nutze „Mit Stimme chatten“.', true);
    return;
  }
  void startLiveDictation();
}
$('#dictationButton').addEventListener('click', toggleDictation);
$('#sendButton').addEventListener('click', () => void submitPrompt());
$('#prompt').addEventListener('input', resizePrompt);
$('#prompt').addEventListener('focus', () => requestAnimationFrame(updateScrollToBottomButton));
window.visualViewport?.addEventListener('resize', updateScrollToBottomButton, { passive: true });
window.visualViewport?.addEventListener('scroll', updateScrollToBottomButton, { passive: true });
$('#prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submitPrompt(); } });

$('#voiceButton').addEventListener('click', () => void startLiveVoice());
$('#cameraToggle').addEventListener('click', () => void startLiveVisualCapture('camera'));
$('#screenToggle').addEventListener('click', () => void startLiveVisualCapture('screen'));
$('#cameraSelect').addEventListener('change', () => { if (state.voice.visualType === 'camera') void startLiveVisualCapture('camera'); });
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
  if (voicePreviewAudio?.socket) {
    try { voicePreviewAudio.socket.close(1000, 'Hörprobe angehalten'); } catch {}
  }
  voicePreviewAudio = null;
  if (voicePreviewContext) {
    voicePreviewContext.close().catch(() => {});
    voicePreviewContext = null;
  }
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
async function requestVoiceSample(name, run) {
  const sample = await requestWorker('/api/voice-preview', { voiceName: name });
  if (!sample.data || !sample.mimeType) throw new Error('Der Sprachdienst hat keine Hörprobe zurückgegeben.');
  if (run !== voicePreviewRun) throw new Error('Hörprobe abgebrochen.');
  return { ...sample, source: 'tts-preview' };
}
async function playVoicePreview(name, button) {
  if (state.voice.active) {
    $('#voicePickerStatus').textContent = 'Beende zuerst das laufende Live-Gespräch, damit ich die gewählte Stimme separat und unverfälscht vorführen kann.';
    return;
  }
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
  $('#voicePickerStatus').textContent = `${name} · erstelle eine Stimmprobe …`;
  try {
    voicePreviewContext = new AudioContext({ latencyHint: 'interactive' });
    await voicePreviewContext.resume();
    let sample = await readVoiceSample(name);
    if (!sample) {
      sample = await requestVoiceSample(name, run);
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
      voicePreviewAudio = null;
      button.textContent = '▶ Anhören';
      $('#voicePickerStatus').textContent = sample.source === 'live-v1'
        ? `${name} · Live-Hörprobe beendet und für spätere Wiedergabe gespeichert`
        : `${name} · Hörprobe beendet und gespeichert; die Live-Stimme kann leicht abweichen`;
      voicePreviewContext?.close().catch(() => {});
      voicePreviewContext = null;
    };
    source.start();
    button.textContent = '■ Stoppen';
    $('#voicePickerStatus').textContent = sample.source === 'live-v1'
      ? `${name} · originale Live-Stimme läuft`
      : `${name} · Stimmprobe läuft (kann leicht vom Live-Modus abweichen)`;
  } catch (error) {
    if (run === voicePreviewRun) {
      stopVoicePreview();
      $('#voicePickerStatus').textContent = error.message || 'Die Live-Hörprobe ist gerade nicht verfügbar.';
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
    const preview = document.createElement('button'); preview.type = 'button'; preview.dataset.previewVoice = voice.name; preview.textContent = '▶ Anhören'; preview.disabled = state.voice.active; preview.title = state.voice.active ? 'Beende zuerst das laufende Live-Gespräch.' : 'Live-Stimme anhören';
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
  $('#voicePickerStatus').textContent = state.voice.active ? 'Beende zuerst das laufende Live-Gespräch, um einzelne Stimmen anzuhören.' : '';
  $('#voicePickerDialog').showModal();
}
$('#voicePickerOpen').addEventListener('click', openVoicePicker);
$('#voicePickerSettingsOpen').addEventListener('click', openVoicePicker);
$('#voicePickerClose').addEventListener('click', () => $('#voicePickerDialog').close());
$('#voicePickerDialog').addEventListener('close', stopVoicePreview);
$('#voicePickerDialog').addEventListener('click', event => { if (event.target === $('#voicePickerDialog')) $('#voicePickerDialog').close(); });
$('#voiceRetry').addEventListener('click', () => { stopLiveVoice(false); void startLiveVoice(true); });
$('#voiceDialog').addEventListener('cancel', event => { event.preventDefault(); stopLiveVoice(); });
$('#voiceDialog').addEventListener('close', () => {
  closeLivePreview();
  if (state.voice.active) stopLiveVoice(false);
  scrollConversationToBottom();
  setTimeout(scrollConversationToBottom, 120);
});
$('#livePreviewClose').addEventListener('click', () => {
  closeLivePreview();
  if (state.voice.previewTranscriptEntry?.isConnected) state.voice.previewTranscriptEntry.querySelector('.voice-transcript-text').textContent = 'Vorschau geschlossen.';
});
$('#livePreviewDialog').addEventListener('cancel', event => { event.preventDefault(); closeLivePreview(); });
$('#livePreviewDialog').addEventListener('click', event => { if (event.target === $('#livePreviewDialog')) closeLivePreview(); });

window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); state.installPrompt = event; $('#installButton').classList.remove('hidden'); });
$('#installButton').addEventListener('click', async () => { if (!state.installPrompt) return; await state.installPrompt.prompt(); state.installPrompt = null; $('#installButton').classList.add('hidden'); });
window.addEventListener('pagehide', () => {
  state.dictationStopRequested = true;
  if (state.dictationStarted) { try { state.dictation?.stop(); } catch {} }
  state.dictation = null;
  stopLiveVoice(false);
});
restoreProfile().then(() => restoreMessages()).catch(() => notice('Profil oder lokaler Chatverlauf konnten nicht geladen werden.', true));
checkWorker().catch(error => { setConnection('offline', 'Nicht erreichbar'); notice(error.message, true); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').then(registration => registration.update()).catch(() => {});





