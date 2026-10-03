const $ = selector => document.querySelector(selector);
const dbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open('bard-ai-pwa', 2);
  request.onupgradeneeded = event => {
    const db = request.result;
    const tx = request.transaction;
    const chats = db.objectStoreNames.contains('chats') ? tx.objectStore('chats') : db.createObjectStore('chats', { keyPath: 'id' });
    const messages = db.objectStoreNames.contains('messages') ? tx.objectStore('messages') : db.createObjectStore('messages', { keyPath: 'id' });
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
  backend: localStorage.getItem('bard_backend_url') || '',
  token: sessionStorage.getItem('bard_session_token') || '',
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

const apiUrl = path => {
  if (!state.backend) throw new Error('Bard AI ist noch nicht verbunden. Hinterlege einmalig die Bard-Server-Adresse unter Verbindung.');
  const base = new URL(state.backend);
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('Der Backend-Endpunkt muss HTTPS verwenden.');
  return new URL(path.replace(/^\//, ''), `${base.href.replace(/\/$/, '')}/`).href;
};
async function api(path, { auth = true, ...options } = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set('content-type', 'application/json');
  if (auth && state.token) headers.set('authorization', `Bearer ${state.token}`);
  const response = await fetch(apiUrl(path), { ...options, headers, cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Server antwortet mit Status ${response.status}.`);
  return data;
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


async function unlock(password) {
  if (!state.backend) throw new Error('Bitte zuerst den HTTPS-Backend-Endpunkt speichern.');
  setConnection('busy', 'Verbinde');
  const result = await api('/api/admin/login', { auth: false, method: 'POST', body: JSON.stringify({ password }) });
  state.token = result.accessToken;
  sessionStorage.setItem('bard_session_token', state.token);
  $('#adminPassword').value = '';
  $('#adminSettings').classList.remove('hidden');
  $('#adminStatus').textContent = 'Entsperrt. Die Sitzung endet automatisch.';
  const config = await api('/api/admin/config');
  $('#liveModel').value = config.liveModel || '';
  $('#imageModel').value = config.imageModel || '';
  $('#keyStatus').textContent = config.apiKeyConfigured ? 'Schlüssel liegt geschützt auf dem Server' : 'Noch nicht eingerichtet';
  setConnection('online', 'Verbunden');
}
function lockAdmin() {
  state.token = '';
  sessionStorage.removeItem('bard_session_token');
  $('#adminSettings').classList.add('hidden');
  $('#adminPassword').value = '';
  $('#providerKey').value = '';
  $('#adminStatus').textContent = 'Gesperrt. Das Passwort wird nicht auf diesem Gerät gespeichert.';
  setConnection(state.backend ? 'online' : 'offline', state.backend ? 'Server bereit' : 'Server fehlt');
}
async function saveAdminConfig() {
  if (!state.token) throw new Error('Bitte das Admin-Panel erneut entsperren.');
  const config = {
    liveModel: $('#liveModel').value.trim(),
    imageModel: $('#imageModel').value.trim(),
    apiKey: $('#providerKey').value.trim()
  };
  await api('/api/admin/config', { method: 'PUT', body: JSON.stringify(config) });
  $('#providerKey').value = '';
  $('#keyStatus').textContent = config.apiKey ? 'Schlüssel verschlüsselt gespeichert' : 'Schlüssel unverändert';
  notice('Admin-Einstellungen sicher gespeichert.');
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
  if (!state.backend) { notice('Bard AI ist noch nicht verbunden. Hinterlege einmalig die Bard-Server-Adresse unter Verbindung.', true); return; }
  captureConversationMemory(text);
  const userMessage = { id: crypto.randomUUID(), role: 'user', text: safeText(text), created: Date.now() };
  state.messages.push(userMessage); renderMessage(userMessage); void persistMessages().catch(() => {});
  $('#prompt').value = ''; resizePrompt(); state.busy = true; typing(true); setConnection('busy', 'Denkt nach');
  try {
    if (state.imageMode) {
      const result = await api('/api/image', { method: 'POST', body: JSON.stringify({ prompt: userMessage.text }) });
      if (!result.image?.data || !result.image?.mimeType) throw new Error('Der Server hat kein Bild zurückgegeben.');
      const answer = { id: crypto.randomUUID(), role: 'assistant', text: result.text || 'Hier ist dein Bild.', image: result.image, created: Date.now() };
      state.messages.push(answer); renderMessage(answer); void persistMessages().catch(() => {});
    } else {
      const history = state.messages.slice(-40).map(({ role, text: content }) => ({ role, text: content }));
      const result = await api('/api/chat', { method: 'POST', body: JSON.stringify({ userName: state.name, memory: state.memory, messages: history }) });
      const answer = { id: crypto.randomUUID(), role: 'assistant', text: safeText(result.text) || 'Ich habe keine Textantwort erhalten.', created: Date.now() };
      state.messages.push(answer); renderMessage(answer); void persistMessages().catch(() => {});
      if (state.speakReplies) speak(answer.text);
    }
  } catch (error) {
    const message = safeText(error.message || 'Die Anfrage ist fehlgeschlagen.');
    notice(message, true);
    if (/Sitzung gesperrt|erneut anmelden/i.test(message)) lockAdmin();
  } finally {
    state.imageMode = false; $('#imageButton').classList.remove('selected'); $('#prompt').placeholder = 'Frag Bard AI …';
    typing(false); state.busy = false; if (!state.backend) setConnection('offline', 'Server fehlt');
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

$('#backendUrl').value = state.backend;
$('#userName').value = state.name;
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
$('#saveBackendUrl').addEventListener('click', () => {
  try {
    const url = new URL($('#backendUrl').value.trim());
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Bitte eine HTTPS-Adresse eingeben.');
    state.backend = url.href.replace(/\/$/, ''); localStorage.setItem('bard_backend_url', state.backend); lockAdmin();
    notice('Server-Adresse auf diesem Gerät gespeichert. Chats und Bilder benötigen kein Admin-Passwort.');
  } catch (error) { $('#adminStatus').textContent = error.message; }
});
$('#unlockForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('#adminStatus').textContent = 'Verbindung wird geprüft …';
  try { await unlock($('#adminPassword').value); $('#adminSettings').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); notice('Admin-Einstellungen entsperrt.'); }
  catch (error) { $('#adminSettings').classList.add('hidden'); $('#adminStatus').textContent = error.message; setConnection('offline', state.backend ? 'Server nicht erreichbar' : 'Server fehlt'); }
});
$('#saveAdminSettings').addEventListener('click', async () => {
  try { await saveAdminConfig(); }
  catch (error) { notice(error.message, true); }
});
$('#lockAdmin').addEventListener('click', lockAdmin);
$('#adminButton').addEventListener('click', () => $('#adminDialog').showModal());
$('#imageButton').addEventListener('click', toggleImageMode);
$('#sendButton').addEventListener('click', () => void submitPrompt());
$('#prompt').addEventListener('input', resizePrompt);
$('#prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submitPrompt(); } });
$('#voiceButton').addEventListener('click', startRecognition);
$('#menuButton').addEventListener('click', () => $('#adminDialog').showModal());
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); state.installPrompt = event; $('#installButton').classList.remove('hidden'); });
$('#installButton').addEventListener('click', async () => { if (!state.installPrompt) return; await state.installPrompt.prompt(); state.installPrompt = null; $('#installButton').classList.add('hidden'); });
window.addEventListener('pagehide', stopRecognition);
restoreMessages().catch(() => notice('Der lokale Chatverlauf konnte nicht geladen werden.', true));
if (state.backend) api('/api/health', { auth: false }).then(() => setConnection('online', 'Server bereit')).catch(() => setConnection('offline', 'Server nicht erreichbar'));
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});

