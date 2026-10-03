const $ = selector => document.querySelector(selector);
const dbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open('bard-ai-pwa', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('messages', { keyPath: 'id' });
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
  messages: []
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
    const tx = db.transaction('messages', 'readwrite');
    const store = tx.objectStore('messages');
    store.clear();
    const rows = state.messages.slice(-80);
    const imageRows = rows.filter(message => message.image).slice(-8);
    const keepImages = new Set(imageRows.map(message => message.id));
    for (const message of rows) { const row = { ...message }; if (row.image && !keepImages.has(row.id)) delete row.image; store.put(row); }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  }));
}
async function restoreMessages() {
  const db = await dbPromise;
  const rows = await new Promise((resolve, reject) => {
    const request = db.transaction('messages').objectStore('messages').getAll();
    request.onsuccess = () => resolve(request.result.slice(-80));
    request.onerror = () => reject(request.error);
  });
  state.messages = rows;
  for (const item of rows) renderMessage(item, false);
  if (rows.length) $('#welcome').classList.add('compact');
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
  localStorage.setItem('bard_user_name', state.name);
  $('#userName').value = state.name;
  $('#nameForm').classList.add('hidden');
  renderMessages();
}
function renderMemory() {
  const list = $('#memoryList');
  if (!list) return;
  list.replaceChildren();
  $('#memoryCount').textContent = state.memory.length ? `${state.memory.length} gespeichert` : 'Noch leer';
  $('#memoryEmpty').classList.toggle('hidden', state.memory.length > 0);
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

