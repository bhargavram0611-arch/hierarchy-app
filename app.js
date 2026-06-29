'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────
const ROOT_ID    = 'root';
const ENC_KEY    = 'hierarchyApp_enc_v1';
const SALT_KEY   = 'hierarchyApp_salt_v1';
const LEGACY_KEY = 'hierarchyApp_v2';       // pre-encryption data
const ITER       = 200000;                  // PBKDF2 iterations (OWASP 2024)

// ─── Runtime state ───────────────────────────────────────────────────────────
let state = {
  nodes: {
    [ROOT_ID]: { id: ROOT_ID, name: 'My Hierarchy', type: 'category', parentId: null, children: [], createdAt: Date.now() }
  },
  path: [ROOT_ID],
  runs: []
};

let cryptoKey = null;   // AES-GCM CryptoKey — lives only in memory, never stored
let ctxTarget = null;
let drag = { active: false, id: null, ghost: null, source: null, lastTarget: null };
let pendingShare       = null;
let shareUrl           = '';
let shareCategoryId    = ROOT_ID;
let categoryPickerCb   = null;
let addLinkItemId      = null;
let lastAutoName       = '';
let renameLinkTarget   = null;
let activeTab          = 'tree';  // 'tree' | 'today' | 'future' | 'done' | 'track'
let trackInterval      = null;
let tabItemId          = null;    // item being viewed from a non-tree tab
let schedItemId        = null;
let schedType          = 'once';
let schedDays          = new Set();

// ─── Crypto helpers ───────────────────────────────────────────────────────────
const _enc = new TextEncoder();
const _dec = new TextDecoder();
const toB64   = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));

async function deriveKey(password, salt) {
  const raw = await crypto.subtle.importKey('raw', _enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptObj(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, _enc.encode(JSON.stringify(obj)));
  return { iv: toB64(iv), ct: toB64(ct) };
}

async function decryptObj(key, payload) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(payload.iv) },
    key,
    fromB64(payload.ct)
  );
  return JSON.parse(_dec.decode(pt));
}

// ─── Persistence ─────────────────────────────────────────────────────────────
async function save() {
  if (!cryptoKey) return;
  try {
    localStorage.setItem(ENC_KEY, JSON.stringify(await encryptObj(cryptoKey, state)));
  } catch (e) { console.error('save failed', e); }
}

async function setupPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key  = await deriveKey(password, salt);

  // Migrate any pre-existing unencrypted data
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy);
      if (parsed?.nodes && parsed?.path) { state = parsed; sanitizePath(); }
      localStorage.removeItem(LEGACY_KEY);
    }
  } catch (_) {}

  cryptoKey = key;
  localStorage.setItem(SALT_KEY, toB64(salt));
  await save();
}

async function unlock(password) {
  const saltB64 = localStorage.getItem(SALT_KEY);
  if (!saltB64) throw new Error('no-salt');
  const key     = await deriveKey(password, fromB64(saltB64));
  const raw     = localStorage.getItem(ENC_KEY);
  if (!raw) throw new Error('no-data');
  const loaded  = await decryptObj(key, JSON.parse(raw));  // throws on wrong password
  state = loaded;
  sanitizePath();
  cryptoKey = key;
}

async function changePassword(oldPwd, newPwd) {
  const saltB64 = localStorage.getItem(SALT_KEY);
  const oldKey  = await deriveKey(oldPwd, fromB64(saltB64));
  await decryptObj(oldKey, JSON.parse(localStorage.getItem(ENC_KEY)));  // verify old pwd
  const newSalt = crypto.getRandomValues(new Uint8Array(16));
  cryptoKey = await deriveKey(newPwd, newSalt);
  localStorage.setItem(SALT_KEY, toB64(newSalt));
  await save();
}

function sanitizePath() {
  state.path = (state.path || [ROOT_ID]).filter(id => state.nodes[id]);
  if (!state.path.length) state.path = [ROOT_ID];
  if (!state.nodes[ROOT_ID]) {
    state.nodes[ROOT_ID] = { id: ROOT_ID, name: 'My Hierarchy', type: 'category', parentId: null, children: [], createdAt: Date.now() };
    state.path = [ROOT_ID];
  }
  migrateData();
}

function migrateData() {
  if (!state.runs) state.runs = [];
  Object.values(state.nodes).forEach(node => {
    if (node.type !== 'item') return;
    if (!node.links) {
      // Migrate old single-url field → links array
      node.links = node.url
        ? [{ id: crypto.randomUUID(), name: detectPlatform(node.url), url: node.url }]
        : [];
      delete node.url;
    }
  });
}

// ─── Schedule utilities ───────────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().slice(0, 10);
const todayDow  = () => new Date().getDay(); // 0 = Sun

function isScheduledToday(node) {
  if (node.type !== 'item' || !node.schedule) return false;
  const s = node.schedule, t = todayStr();
  if (s.type === 'once')   return s.date <= t && !node.done;
  if (s.type === 'daily')  return node.doneDate !== t;
  if (s.type === 'weekly') return (s.days || []).includes(todayDow()) && node.doneDate !== t;
  return false;
}

function isScheduledFuture(node) {
  if (node.type !== 'item' || !node.schedule) return false;
  return node.schedule.type === 'once' && node.schedule.date > todayStr() && !node.done;
}

function isItemDone(node) { return node.type === 'item' && node.done === true; }

function isDoneToday(node) {
  if (!node.schedule) return false;
  if (node.schedule.type === 'once') return node.done === true;
  return node.doneDate === todayStr();
}

function getScheduleLabel(node) {
  if (!node.schedule) return '';
  const s = node.schedule;
  if (s.type === 'once')   return formatSchedDate(s.date);
  if (s.type === 'daily')  return 'Every day';
  if (s.type === 'weekly') {
    const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const names = [...(s.days || [])].sort().map(d => DAYS[d]);
    return 'Every ' + (names.length ? names.join(', ') : '—');
  }
  return '';
}

function formatSchedDate(iso) {
  const t = todayStr();
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const tStr = tomorrow.toISOString().slice(0, 10);
  if (iso === t)    return 'Today';
  if (iso === tStr) return 'Tomorrow';
  if (iso < t)      return `Overdue · ${iso}`;
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric',
    year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}

function completeItem(id) {
  const n = state.nodes[id]; if (!n) return;
  if (!n.schedule || n.schedule.type === 'once') { n.done = true; n.doneAt = Date.now(); }
  else { n.doneDate = todayStr(); }
  save(); render();
}

function uncompleteItem(id) {
  const n = state.nodes[id]; if (!n) return;
  n.done = false; n.doneDate = null; n.doneAt = null;
  save(); render();
}

// ─── Queries ─────────────────────────────────────────────────────────────────
const current = () => state.nodes[state.path[state.path.length - 1]];
const childCount = node => node.type === 'category' ? (node.children?.length ?? 0) : 0;

// ─── Mutations ───────────────────────────────────────────────────────────────
function addNode(name, type) {
  const parent = current();
  const id = crypto.randomUUID();
  const node = { id, name: name.trim(), type, parentId: parent.id, createdAt: Date.now() };
  if (type === 'category') node.children = [];
  if (type === 'item')   { node.notes = ''; node.links = []; }
  state.nodes[id] = node;
  parent.children.push(id);
  save(); render();
}

function renameNode(id, name) {
  if (state.nodes[id]) { state.nodes[id].name = name.trim(); save(); render(); }
}

function deleteNode(id) {
  _deleteTree(id);
  const idx = state.path.indexOf(id);
  if (idx !== -1) state.path = state.path.slice(0, Math.max(1, idx));
  save(); render();
}

function _deleteTree(id) {
  const node = state.nodes[id];
  if (!node) return;
  if (node.type === 'category') node.children?.forEach(_deleteTree);
  if (node.parentId && state.nodes[node.parentId]) {
    state.nodes[node.parentId].children = state.nodes[node.parentId].children.filter(c => c !== id);
  }
  delete state.nodes[id];
}

// ─── Navigation ──────────────────────────────────────────────────────────────
function navInto(id) { state.path.push(id); render(); }
function navBack()   {
  if (activeTab !== 'tree' && tabItemId) { tabItemId = null; render(); return; }
  if (state.path.length > 1) { state.path.pop(); render(); }
}
function navTo(idx)  { state.path = state.path.slice(0, idx + 1); render(); }

// ─── Lock Screen ─────────────────────────────────────────────────────────────
function showLockScreen(mode) {
  const isSetup = mode === 'setup';
  $('lockTitle').textContent   = isSetup ? 'Set a Password' : 'Unlock App';
  $('lockDesc').textContent    = isSetup
    ? 'Your data will be encrypted and protected.'
    : 'Enter your password to access your data.';
  $('lockConfirmRow').style.display = isSetup ? 'block' : 'none';
  $('lockWarning').style.display    = isSetup ? 'block' : 'none';
  $('lockSubmitBtn').textContent    = isSetup ? 'Set Password' : 'Unlock';
  $('lockInput').value    = '';
  $('lockConfirm').value  = '';
  $('lockError').textContent = '';
  $('lockSubmitBtn').disabled = false;
  $('lockScreen').dataset.mode = mode;
  $('lockScreen').classList.add('active');
  setTimeout(() => $('lockInput').focus(), 300);
}

function hideLockScreen() { $('lockScreen').classList.remove('active'); }

async function submitLock() {
  const mode     = $('lockScreen').dataset.mode;
  const password = $('lockInput').value;
  const err      = $('lockError');
  const btn      = $('lockSubmitBtn');
  err.textContent = '';

  if (!password) { err.textContent = 'Please enter a password.'; $('lockInput').focus(); return; }

  if (mode === 'setup') {
    const confirm = $('lockConfirm').value;
    if (password.length < 4) { err.textContent = 'Minimum 4 characters.'; return; }
    if (password !== confirm)  { err.textContent = 'Passwords do not match.'; $('lockConfirm').focus(); return; }
    btn.textContent = 'Setting up…'; btn.disabled = true;
    try {
      await setupPassword(password);
      hideLockScreen(); render(); processPendingShare();
    } catch (e) {
      err.textContent = 'Setup failed. Try again.';
      btn.textContent = 'Set Password'; btn.disabled = false;
    }
  } else {
    btn.textContent = 'Unlocking…'; btn.disabled = true;
    try {
      await unlock(password);
      hideLockScreen(); render(); processPendingShare();
    } catch (e) {
      err.textContent = 'Incorrect password.';
      $('lockInput').value = ''; $('lockInput').focus();
      btn.textContent = 'Unlock'; btn.disabled = false;
    }
  }
}

function lockApp() {
  cryptoKey = null;
  closeModal('secSheet');
  showLockScreen('unlock');
}

// ─── Change Password ─────────────────────────────────────────────────────────
async function submitChangePassword() {
  const oldPwd  = $('cpOld').value;
  const newPwd  = $('cpNew').value;
  const confirm = $('cpConfirm').value;
  const err     = $('cpError');
  const btn     = $('cpSaveBtn');
  err.textContent = '';

  if (!oldPwd || !newPwd) { err.textContent = 'All fields required.'; return; }
  if (newPwd.length < 4)   { err.textContent = 'Minimum 4 characters.'; return; }
  if (newPwd !== confirm)   { err.textContent = 'New passwords do not match.'; return; }

  btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    await changePassword(oldPwd, newPwd);
    closeModal('changePasswordModal');
    $('cpOld').value = ''; $('cpNew').value = ''; $('cpConfirm').value = '';
  } catch (e) {
    err.textContent = 'Current password is incorrect.';
    $('cpOld').focus();
  } finally {
    btn.textContent = 'Save'; btn.disabled = false;
  }
}

// ─── Render ──────────────────────────────────────────────────────────────────
function render() {
  if (activeTab !== 'track') clearTrackTick();
  renderHeader();
  renderTabs();
  renderBreadcrumb();

  if (activeTab !== 'tree') {
    $('fab').style.display = 'none';
    if (tabItemId && state.nodes[tabItemId]) {
      $('emptyState').style.display = 'none';
      renderItemDetail(state.nodes[tabItemId]);
    } else {
      tabItemId = null;
      renderTabView();
    }
  } else {
    const node = current();
    const isDetail = node.type === 'item';
    $('fab').style.display = isDetail ? 'none' : 'flex';
    if (isDetail) renderItemDetail(node);
    else renderList();
  }
}

function renderItemDetail(node) {
  $('emptyState').style.display = 'none';
  const listEl = $('itemList');
  listEl.innerHTML = '';

  const editor = el('div', 'notes-editor');

  // Schedule section
  const schedSec = el('div', 'sched-section');
  const lbl = getScheduleLabel(node);
  if (lbl) {
    const row = el('div', 'sched-row');
    const chip = el('span', 'sched-chip');
    const isOverdue = node.schedule?.type === 'once' && node.schedule?.date < todayStr() && !node.done;
    if (isOverdue) chip.classList.add('overdue');
    chip.textContent = lbl;
    row.appendChild(chip);

    const doneBtn = el('button', `sched-done-btn${isDoneToday(node) ? ' done' : ''}`);
    doneBtn.textContent = isDoneToday(node) ? '✓ Done' : 'Mark done';
    doneBtn.onclick = () => isDoneToday(node) ? uncompleteItem(node.id) : completeItem(node.id);
    row.appendChild(doneBtn);

    const changeBtn = el('button', 'sched-edit-btn');
    changeBtn.textContent = '✎';
    changeBtn.title = 'Change schedule';
    changeBtn.onclick = () => openScheduleModal(node.id);
    row.appendChild(changeBtn);

    const clearBtn = el('button', 'sched-clear-btn');
    clearBtn.textContent = '✕';
    clearBtn.title = 'Remove schedule';
    clearBtn.onclick = () => { node.schedule = null; node.done = false; node.doneDate = null; save(); render(); };
    row.appendChild(clearBtn);

    schedSec.appendChild(row);
  } else {
    const addBtn = el('button', 'sched-add-btn');
    addBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3h-1V1h-2v2H8V1H6v2H5C3.9 3 3 3.9 3 5v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zm-7-7h-3v3H7v-2H4v-2h3V9h2v3h3v2z"/></svg> Set schedule`;
    addBtn.onclick = () => openScheduleModal(node.id);
    schedSec.appendChild(addBtn);
  }
  editor.appendChild(schedSec);

  // Links section
  const links = node.links || [];
  if (links.length) {
    const sec = el('div', 'links-section');
    links.forEach((link, i) => sec.appendChild(renderLinkCard(node.id, link, i + 1)));
    editor.appendChild(sec);
  }

  // Add Link button
  const addBtn = el('button', 'add-link-btn');
  addBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg> Add Link`;
  addBtn.onclick = () => openAddLinkModal(node.id);
  editor.appendChild(addBtn);

  // Notes textarea
  const textarea = el('textarea', 'notes-textarea');
  textarea.placeholder = 'Write your notes here…';
  textarea.value = node.notes || '';
  textarea.setAttribute('aria-label', 'Notes for ' + node.name);

  const status = el('div', 'save-status');
  let timer;
  textarea.oninput = () => {
    clearTimeout(timer);
    status.textContent = '';
    timer = setTimeout(() => {
      node.notes = textarea.value;
      save();
      status.textContent = '✓ Saved';
      setTimeout(() => { status.textContent = ''; }, 1500);
    }, 600);
  };

  editor.appendChild(textarea);
  editor.appendChild(status);
  listEl.appendChild(editor);
  if (!links.length) setTimeout(() => textarea.focus(), 150);
}

function renderLinkCard(itemId, link, num) {
  const card = el('div', 'link-card');
  const thumb = getYoutubeThumbnail(link.url);

  if (thumb) {
    const img = el('img', 'link-thumb');
    img.src = thumb; img.alt = link.name;
    img.onerror = () => { img.style.display = 'none'; };
    card.appendChild(img);
  } else {
    const ico = el('div', 'link-platform-ico');
    ico.textContent = getPlatformIcon(link.url);
    card.appendChild(ico);
  }

  const info    = el('div', 'link-info');
  const nameRow = el('div', 'link-name-row');
  const numEl   = el('span', 'link-num');  numEl.textContent = `${num}.`;
  const nameEl  = el('span', 'link-name'); nameEl.textContent = link.name;
  nameRow.appendChild(numEl); nameRow.appendChild(nameEl);
  const urlEl   = el('div', 'link-url');   urlEl.textContent = link.url;
  info.appendChild(nameRow); info.appendChild(urlEl);

  const actions = el('div', 'link-actions');

  const editBtn = el('button', 'link-action-btn');
  editBtn.title = 'Rename';
  editBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
  editBtn.onclick = e => { e.stopPropagation(); openRenameLinkModal(itemId, link.id, link.name); };

  const delBtn = el('button', 'link-action-btn danger');
  delBtn.title = 'Delete';
  delBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
  delBtn.onclick = e => { e.stopPropagation(); if (confirm(`Delete link "${link.name}"?`)) deleteLink(itemId, link.id); };

  actions.appendChild(editBtn); actions.appendChild(delBtn);

  card.appendChild(info); card.appendChild(actions);

  card.onclick = e => {
    if (e.target.closest('.link-actions')) return;
    window.open(link.url, '_blank', 'noopener');
  };

  return card;
}

function getYoutubeThumbnail(url) {
  const m = url?.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?\s/]+)/);
  return m ? `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg` : null;
}

// ─── Link CRUD ────────────────────────────────────────────────────────────────
function addLink(itemId, name, url) {
  const node = state.nodes[itemId];
  if (!node || node.type !== 'item') return;
  if (!node.links) node.links = [];
  node.links.push({ id: crypto.randomUUID(), name, url });
  save(); render();
}

function deleteLink(itemId, linkId) {
  const node = state.nodes[itemId];
  if (!node) return;
  node.links = (node.links || []).filter(l => l.id !== linkId);
  save(); render();
}

function renameLink(itemId, linkId, name) {
  const node = state.nodes[itemId];
  if (!node) return;
  const link = (node.links || []).find(l => l.id === linkId);
  if (link) { link.name = name; save(); render(); }
}

// ─── Add Link Modal ───────────────────────────────────────────────────────────
function openAddLinkModal(itemId) {
  addLinkItemId   = itemId;
  lastAutoName    = '';
  $('linkUrlInput').value  = '';
  $('linkNameInput').value = '';
  $('linkUrlInput').classList.remove('shake');
  openModal('addLinkModal');
  setTimeout(() => $('linkUrlInput').focus(), 300);
}

function onLinkUrlInput(val) {
  const detected = detectPlatform(val.trim());
  if (!$('linkNameInput').value.trim() || $('linkNameInput').value === lastAutoName) {
    $('linkNameInput').value = detected;
    lastAutoName = detected;
  }
}

function submitAddLink() {
  const url  = $('linkUrlInput').value.trim();
  const name = $('linkNameInput').value.trim() || detectPlatform(url);
  if (!url) { shake('linkUrlInput'); return; }
  try { new URL(url); } catch { shake('linkUrlInput'); return; }
  addLink(addLinkItemId, name, url);
  closeModal('addLinkModal');
  addLinkItemId = null;
}

// ─── Rename Link Modal ────────────────────────────────────────────────────────
function openRenameLinkModal(itemId, linkId, currentName) {
  renameLinkTarget = { itemId, linkId };
  $('renameInput').value = currentName;
  $('renameInput').classList.remove('shake');
  openModal('renameModal');
  setTimeout(() => { $('renameInput').focus(); $('renameInput').select(); }, 300);
}

function renderHeader() {
  let showBack;
  if (activeTab === 'tree') showBack = state.path.length > 1;
  else                      showBack = tabItemId !== null;
  $('backBtn').style.display = showBack ? 'flex' : 'none';

  let title;
  if (activeTab !== 'tree' && tabItemId) title = state.nodes[tabItemId]?.name || '';
  else if (activeTab === 'today')         title = 'Today';
  else if (activeTab === 'future')        title = 'Upcoming';
  else if (activeTab === 'done')          title = 'Done';
  else if (activeTab === 'track')         title = 'Track';
  else                                    title = current().name;
  $('headerTitle').textContent = title;
}

function renderTabs() {
  const todayCount = Object.values(state.nodes).filter(isScheduledToday).length;
  const TABS = [
    { id: 'tree',   label: 'All',      svg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>` },
    { id: 'today',  label: 'Today',    svg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3h-1V1h-2v2H8V1H6v2H5C3.9 3 3 3.9 3 5v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM7 10h5v5H7z"/></svg>`, badge: todayCount },
    { id: 'future', label: 'Upcoming', svg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3h-1V1h-2v2H8V1H6v2H5C3.9 3 3 3.9 3 5v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zm-2-5h-4v4h-2v-4H9v-2h2V9h2v3h4v2z"/></svg>` },
    { id: 'done',   label: 'Done',     svg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>` },
    { id: 'track',  label: 'Track',    svg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/></svg>` },
  ];
  const bar = $('tabBar');
  bar.innerHTML = '';
  TABS.forEach(t => {
    const btn = el('button', `tab-btn${activeTab === t.id ? ' active' : ''}`);
    btn.innerHTML = `${t.svg}<span>${t.label}</span>`;
    if (t.badge) { const b = el('span', 'tab-badge'); b.textContent = t.badge; btn.appendChild(b); }
    btn.onclick = () => { activeTab = t.id; tabItemId = null; render(); };
    bar.appendChild(btn);
  });
}

function renderBreadcrumb() {
  const bc = $('breadcrumb');
  bc.style.display = (activeTab === 'tree') ? '' : 'none';
  bc.innerHTML = '';
  state.path.forEach((id, i) => {
    const node = state.nodes[id];
    if (!node) return;
    if (i > 0) { const s = el('span', 'bc-sep'); s.textContent = '›'; bc.appendChild(s); }
    const wrap = el('span', 'bc-item');
    const btn  = el('button', 'bc-btn');
    btn.textContent = i === 0 ? '⌂ Home' : node.name;
    btn.onclick = () => navTo(i);
    wrap.appendChild(btn);
    bc.appendChild(wrap);
  });
  bc.scrollLeft = bc.scrollWidth;
}

function renderList() {
  const node    = current();
  const emptyEl = $('emptyState');
  const listEl  = $('itemList');
  const kids    = (node.children ?? []).map(id => state.nodes[id]).filter(Boolean);

  if (!kids.length) { emptyEl.style.display = 'block'; listEl.innerHTML = ''; return; }
  emptyEl.style.display = 'none';
  listEl.innerHTML = '';
  kids.forEach((n, i) => {
    const li = el('li'); li.appendChild(makeCard(n, i)); listEl.appendChild(li);
  });
}

function renderTabView() {
  const listEl = $('itemList');
  const emptyEl = $('emptyState');
  listEl.innerHTML = '';

  if (activeTab === 'track') { renderTrackTab(); return; }

  let items, emptyIcon, emptyMsg;
  if (activeTab === 'today') {
    items = Object.values(state.nodes).filter(isScheduledToday);
    items.sort((a, b) => (a.schedule?.date || '').localeCompare(b.schedule?.date || ''));
    emptyIcon = '📅'; emptyMsg = 'Nothing due today';
  } else if (activeTab === 'future') {
    items = Object.values(state.nodes).filter(isScheduledFuture);
    items.sort((a, b) => a.schedule.date.localeCompare(b.schedule.date));
    emptyIcon = '🗓'; emptyMsg = 'No upcoming items';
  } else {
    items = Object.values(state.nodes).filter(isItemDone);
    items.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    emptyIcon = '✅'; emptyMsg = 'No completed items';
  }

  if (!items.length) {
    emptyEl.style.display = 'block';
    emptyEl.innerHTML = `<div class="empty-icon">${emptyIcon}</div><h2>${emptyMsg}</h2><p>Set a schedule on any item to see it here</p>`;
    return;
  }
  emptyEl.style.display = 'none';
  items.forEach(node => { const li = el('li'); li.appendChild(makeScheduledCard(node)); listEl.appendChild(li); });
}

const ICON_CHECK_DONE  = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`;
const ICON_CHECK_EMPTY = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/></svg>`;

function makeScheduledCard(node) {
  const card = el('div', 'item-card');

  const chk = el('button', `sched-check${isDoneToday(node) ? ' checked' : ''}`);
  chk.innerHTML = isDoneToday(node) ? ICON_CHECK_DONE : ICON_CHECK_EMPTY;
  chk.onclick = e => { e.stopPropagation(); isDoneToday(node) ? uncompleteItem(node.id) : completeItem(node.id); };
  card.appendChild(chk);

  const info = el('div', 'item-info');
  const nameEl = el('div', 'item-name');
  if (node.done) nameEl.classList.add('strikethrough');
  nameEl.textContent = node.name;
  info.appendChild(nameEl);

  const path = getNodePath(node.id);
  if (path) { const p = el('div', 'item-meta'); p.textContent = path; info.appendChild(p); }

  const lbl = getScheduleLabel(node);
  if (lbl) {
    const chip = el('span', 'sched-chip');
    const isOverdue = node.schedule?.type === 'once' && node.schedule?.date < todayStr() && !node.done;
    if (isOverdue) chip.classList.add('overdue');
    chip.textContent = lbl;
    info.appendChild(chip);
  }
  card.appendChild(info);

  const chev = el('div', 'item-chevron'); chev.innerHTML = ICON_CHEV; card.appendChild(chev);

  card.onclick = e => { if (e.target.closest('.sched-check')) return; tabItemId = node.id; render(); };
  return card;
}

function makeCard(node, idx) {
  const isCat = node.type === 'category';
  const card  = el('div', 'item-card');
  card.dataset.id = node.id;
  card.style.animationDelay = `${idx * 30}ms`;

  // Drag handle
  const handle = el('div', 'drag-handle');
  handle.innerHTML = ICON_DRAG;
  handle.setAttribute('aria-hidden', 'true');
  handle.addEventListener('pointerdown', e => startDrag(e, card, node.id));
  handle.addEventListener('click', e => e.stopPropagation());
  card.appendChild(handle);

  // Icon
  const ico = el('div', `item-ico ${isCat ? 'cat' : 'leaf'}`);
  ico.innerHTML = isCat ? ICON_FOLDER : ICON_ITEM;
  card.appendChild(ico);

  // Info
  const info   = el('div', 'item-info');
  const nameEl = el('div', 'item-name');
  nameEl.textContent = node.name;
  if (node.done) nameEl.classList.add('strikethrough');
  info.appendChild(nameEl);
  if (isCat) {
    const meta = el('div', 'item-meta');
    const c = childCount(node);
    meta.textContent = c === 0 ? 'Empty' : `${c} ${c === 1 ? 'item' : 'items'}`;
    info.appendChild(meta);
  } else {
    const metaParts = [];
    const lc = node.links?.length;
    if (lc) metaParts.push(`${lc} link${lc > 1 ? 's' : ''}`);
    if (node.notes?.trim()) metaParts.push(node.notes.split('\n')[0].slice(0, 50));
    if (metaParts.length) {
      const meta = el('div', 'item-meta notes-preview');
      meta.textContent = metaParts.join(' · ');
      info.appendChild(meta);
    }
  }
  card.appendChild(info);

  // Chevron
  const chev = el('div', 'item-chevron'); chev.innerHTML = ICON_CHEV; card.appendChild(chev);

  // More button
  const moreBtn = el('button', 'item-more');
  moreBtn.setAttribute('aria-label', 'More options');
  moreBtn.innerHTML = ICON_DOTS;
  moreBtn.onclick = e => { e.stopPropagation(); openCtxMenu(e, node.id); };
  card.appendChild(moreBtn);

  card.addEventListener('click', e => {
    if (e.target.closest('.item-more') || e.target.closest('.drag-handle')) return;
    navInto(node.id);
  });

  // Long-press → context menu
  let lpTimer;
  card.addEventListener('touchstart', e => {
    if (e.target.closest('.item-more') || e.target.closest('.drag-handle')) return;
    lpTimer = setTimeout(() => {
      const t = e.touches[0];
      openCtxMenuAt(t.clientX, t.clientY, node.id);
    }, 550);
  }, { passive: true });
  card.addEventListener('touchend',  () => clearTimeout(lpTimer));
  card.addEventListener('touchmove', () => clearTimeout(lpTimer));

  return card;
}

// ─── Drag & Drop ─────────────────────────────────────────────────────────────
function reorderNode(dragId, targetId, insertBefore) {
  if (dragId === targetId) return;
  const n = state.nodes[dragId], t = state.nodes[targetId];
  if (!n || !t || n.parentId !== t.parentId) return;
  const children = state.nodes[n.parentId].children;
  const fromIdx  = children.indexOf(dragId);
  if (fromIdx === -1) return;
  children.splice(fromIdx, 1);
  const toIdx = children.indexOf(targetId);
  children.splice(insertBefore ? toIdx : toIdx + 1, 0, dragId);
  save(); render();
}

function clearDropIndicators() {
  document.querySelectorAll('.drop-above,.drop-below')
    .forEach(e => e.classList.remove('drop-above', 'drop-below'));
}

function startDrag(e, card, nodeId) {
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  const startX = e.clientX, startY = e.clientY;
  const rect   = card.getBoundingClientRect();
  let activated = false;

  function activate() {
    activated = true;
    drag.active = true; drag.id = nodeId; drag.source = card;
    drag.offsetY = startY - rect.top;
    const g = card.cloneNode(true);
    g.className = 'item-card drag-ghost';
    Object.assign(g.style, { width: rect.width + 'px', top: rect.top + 'px', left: rect.left + 'px' });
    document.body.appendChild(g);
    drag.ghost = g;
    card.classList.add('drag-source');
  }

  function move(ev) {
    if (!activated && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
    if (!activated) activate();
    ev.preventDefault();
    drag.ghost.style.top = (ev.clientY - drag.offsetY) + 'px';
    drag.ghost.style.visibility = 'hidden';
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    drag.ghost.style.visibility = '';
    clearDropIndicators();
    const tc = under?.closest('[data-id]');
    if (tc && tc !== card) {
      const r = tc.getBoundingClientRect();
      const before = ev.clientY < r.top + r.height / 2;
      drag.lastTarget = { id: tc.dataset.id, before };
      tc.classList.add(before ? 'drop-above' : 'drop-below');
    } else { drag.lastTarget = null; }
  }

  function up() {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if (!activated) return;
    if (drag.lastTarget) reorderNode(drag.id, drag.lastTarget.id, drag.lastTarget.before);
    drag.ghost?.remove();
    card.classList.remove('drag-source');
    clearDropIndicators();
    drag = { active: false, id: null, ghost: null, source: null, lastTarget: null };
  }

  document.addEventListener('pointermove', move, { passive: false });
  document.addEventListener('pointerup', up);
}

// ─── Search ──────────────────────────────────────────────────────────────────
function openSearch() {
  $('searchOverlay').classList.add('active');
  setTimeout(() => $('searchInput').focus(), 120);
}

function closeSearch() {
  $('searchOverlay').classList.remove('active');
  $('searchInput').value = '';
  $('searchResults').innerHTML = '';
}

function performSearch(raw) {
  const q = raw.trim().toLowerCase();
  const resultsEl = $('searchResults');
  resultsEl.innerHTML = '';
  if (!q) return;

  const matches = Object.values(state.nodes).filter(n =>
    n.id !== ROOT_ID && (
      n.name.toLowerCase().includes(q) ||
      n.notes?.toLowerCase().includes(q)
    )
  );

  if (!matches.length) {
    const empty = el('div', 'search-empty'); empty.textContent = 'No results found';
    resultsEl.appendChild(empty); return;
  }

  matches.slice(0, 60).forEach(node => {
    const isCat = node.type === 'category';
    const row   = el('div', 'search-result');

    const ico = el('div', `item-ico ${isCat ? 'cat' : 'leaf'} search-ico`);
    ico.innerHTML = isCat ? ICON_FOLDER : ICON_ITEM;
    row.appendChild(ico);

    const info   = el('div', 'item-info');
    const nameEl = el('div', 'item-name');
    nameEl.innerHTML = highlight(node.name, q);
    info.appendChild(nameEl);

    const pathStr = getNodePath(node.id);
    if (pathStr) {
      const pathEl = el('div', 'search-path'); pathEl.textContent = pathStr; info.appendChild(pathEl);
    }

    if (!isCat && node.notes?.trim()) {
      const snip = findNoteSnippet(node.notes, q);
      if (snip) {
        const snipEl = el('div', 'search-snippet'); snipEl.innerHTML = snip; info.appendChild(snipEl);
      }
    }

    row.appendChild(info);
    const chev = el('div', 'item-chevron'); chev.innerHTML = ICON_CHEV; row.appendChild(chev);
    row.onclick = () => { closeSearch(); navigateToNode(node.id); };
    resultsEl.appendChild(row);
  });
}

function getNodePath(id) {
  const parts = [];
  let cur = state.nodes[state.nodes[id]?.parentId];
  while (cur) {
    parts.unshift(cur.id === ROOT_ID ? 'Home' : cur.name);
    if (!cur.parentId) break;
    cur = state.nodes[cur.parentId];
  }
  return parts.join(' › ');
}

function navigateToNode(id) {
  const node = state.nodes[id]; if (!node) return;
  const pathIds = [];
  let cur = node;
  while (cur) { pathIds.unshift(cur.id); if (!cur.parentId) break; cur = state.nodes[cur.parentId]; }
  state.path = pathIds; render();
}

function highlight(text, q) {
  const i = text.toLowerCase().indexOf(q);
  if (i === -1) return escapeHtml(text);
  return escapeHtml(text.slice(0, i)) +
    `<mark>${escapeHtml(text.slice(i, i + q.length))}</mark>` +
    escapeHtml(text.slice(i + q.length));
}

function findNoteSnippet(notes, q) {
  const i = notes.toLowerCase().indexOf(q);
  if (i === -1) return null;
  const s = Math.max(0, i - 30), e = Math.min(notes.length, i + q.length + 50);
  const raw = (s > 0 ? '…' : '') + notes.slice(s, e).replace(/\n/g, ' ') + (e < notes.length ? '…' : '');
  return highlight(raw, q);
}

// ─── Context Menu ─────────────────────────────────────────────────────────────
function openCtxMenu(e, id) {
  const rect = e.currentTarget.getBoundingClientRect();
  openCtxMenuAt(rect.right, rect.bottom, id);
}

function openCtxMenuAt(x, y, id) {
  ctxTarget = id;
  const menu = $('ctxMenu');
  menu.classList.add('open');
  $('backdrop').classList.add('on');
  const mw = 180, mh = 110;
  const left = Math.max(8, Math.min(x - mw, window.innerWidth - mw - 8));
  const top  = (y + mh > window.innerHeight - 8) ? y - mh - 4 : y + 4;
  menu.style.left = `${left}px`; menu.style.top = `${top}px`;
}

function closeCtxMenu() {
  $('ctxMenu').classList.remove('open');
  $('backdrop').classList.remove('on');
  ctxTarget = null;
}

// ─── Add Modal ───────────────────────────────────────────────────────────────
let addType = 'category';

function openAddModal() {
  addType = 'category';
  $('typeCatBtn').classList.add('active');
  $('typeItemBtn').classList.remove('active');
  $('addInput').value = '';
  $('addInput').classList.remove('shake');
  openModal('addModal');
  setTimeout(() => $('addInput').focus(), 300);
}

function submitAdd() {
  const name = $('addInput').value.trim();
  if (!name) { shake('addInput'); return; }
  addNode(name, addType);
  closeModal('addModal');
}

// ─── Rename Modal ─────────────────────────────────────────────────────────────
let renameTarget = null;

function openRenameModal(id) {
  renameTarget = id;
  $('renameInput').value = state.nodes[id]?.name ?? '';
  $('renameInput').classList.remove('shake');
  openModal('renameModal');
  setTimeout(() => { $('renameInput').focus(); $('renameInput').select(); }, 300);
}

function submitRename() {
  const name = $('renameInput').value.trim();
  if (!name) { shake('renameInput'); return; }
  if (renameLinkTarget) {
    renameLink(renameLinkTarget.itemId, renameLinkTarget.linkId, name);
    renameLinkTarget = null;
  } else {
    renameNode(renameTarget, name);
    renameTarget = null;
  }
  closeModal('renameModal');
}

// ─── Modal helpers ────────────────────────────────────────────────────────────
function openModal(id)  { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }

function shake(inputId) {
  const inp = $(inputId);
  inp.classList.remove('shake'); void inp.offsetWidth;
  inp.classList.add('shake'); inp.focus();
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ─── SVG Icons ───────────────────────────────────────────────────────────────
const ICON_FOLDER = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.11 0-2 .89-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.11-.89-2-2-2h-8l-2-2z"/></svg>`;
const ICON_ITEM   = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>`;
const ICON_CHEV   = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.58L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>`;
const ICON_DOTS   = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>`;
const ICON_DRAG   = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="2"/><circle cx="15" cy="5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="19" r="2"/><circle cx="15" cy="19" r="2"/></svg>`;
const ICON_BACK   = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>`;
const ICON_LOCK   = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>`;

// ─── Share Target ────────────────────────────────────────────────────────────
function checkSharedContent() {
  const p     = new URLSearchParams(window.location.search);
  const url   = p.get('url') || extractUrl(p.get('text'));
  const title = p.get('title') || '';
  if (url) {
    pendingShare = { url, name: title };
    window.history.replaceState({}, '', window.location.pathname);
  }
}

function processPendingShare() {
  if (!pendingShare) return;
  const { url, name } = pendingShare;
  pendingShare = null;
  shareUrl        = url;
  shareCategoryId = ROOT_ID;
  $('shareNameInput').value     = name || detectPlatform(url);
  $('shareNameInput').classList.remove('shake');
  $('shareUrlPreview').textContent = url;
  $('shareUrlPreview').href        = url;
  updateShareDest();
  openModal('shareModal');
  setTimeout(() => { $('shareNameInput').focus(); $('shareNameInput').select(); }, 300);
}

function extractUrl(text) {
  if (!text) return '';
  const m = text.match(/https?:\/\/[^\s]+/);
  return m ? m[0] : '';
}

function detectPlatform(url) {
  if (!url) return 'Link';
  if (url.includes('instagram.com')) return 'Instagram';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'YouTube';
  if (url.includes('facebook.com') || url.includes('fb.com')) return 'Facebook';
  if (url.includes('twitter.com') || url.includes('x.com')) return 'X (Twitter)';
  if (url.includes('tiktok.com')) return 'TikTok';
  try { return new URL(url).hostname.replace('www.', ''); } catch { return 'Link'; }
}

function getPlatformIcon(url) {
  if (!url) return '🔗';
  if (url.includes('instagram.com')) return '📸';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return '▶️';
  if (url.includes('facebook.com') || url.includes('fb.com')) return '👥';
  if (url.includes('twitter.com') || url.includes('x.com')) return '🐦';
  if (url.includes('tiktok.com')) return '🎵';
  return '🔗';
}

function updateShareDest() {
  const cat = state.nodes[shareCategoryId];
  $('shareDestBtn').textContent = `📁 ${cat?.id === ROOT_ID ? 'Home' : (cat?.name || 'Home')}`;
}

function saveSharedItem() {
  const name = $('shareNameInput').value.trim();
  if (!name) { shake('shareNameInput'); return; }

  const id   = crypto.randomUUID();
  const node = { id, name, type: 'item', parentId: shareCategoryId,
    links: [{ id: crypto.randomUUID(), name: detectPlatform(shareUrl), url: shareUrl }],
    notes: '', createdAt: Date.now() };
  state.nodes[id] = node;
  state.nodes[shareCategoryId].children.push(id);
  save();
  closeModal('shareModal');

  // Navigate to the category where it was saved
  state.path = buildPathTo(shareCategoryId);
  render();
}

function buildPathTo(id) {
  const ids = [];
  let cur = state.nodes[id];
  while (cur) { ids.unshift(cur.id); if (!cur.parentId) break; cur = state.nodes[cur.parentId]; }
  return ids;
}

// ─── Move ────────────────────────────────────────────────────────────────────
let moveTarget = null;

function moveNode(id, targetCatId) {
  const node = state.nodes[id];
  if (!node || targetCatId === node.parentId) return;

  // Remove from old parent
  const oldParent = state.nodes[node.parentId];
  if (oldParent) oldParent.children = oldParent.children.filter(c => c !== id);

  // Add to new parent
  const newParent = state.nodes[targetCatId];
  if (!newParent || newParent.type !== 'category') return;
  newParent.children.push(id);
  node.parentId = targetCatId;

  // Fix navigation path if we moved something we were inside
  const idx = state.path.indexOf(id);
  if (idx !== -1) {
    state.path = state.path.slice(0, Math.max(1, idx));
  }

  save(); render();
}

function getDescendants(id) {
  const set = new Set();
  function walk(nodeId) {
    const node = state.nodes[nodeId];
    if (!node || node.type !== 'category') return;
    node.children?.forEach(cid => { set.add(cid); walk(cid); });
  }
  walk(id);
  return set;
}

function openMoveModal(id) {
  moveTarget = id;
  const node = state.nodes[id];
  $('moveTitle').textContent = `Move "${node.name}" to…`;
  $('moveSearch').value = '';
  populateMoveList('');
  openModal('moveModal');
  setTimeout(() => $('moveSearch').focus(), 300);
}

function populateMoveList(query) {
  const listEl = $('moveList');
  listEl.innerHTML = '';
  const q        = query.trim().toLowerCase();
  const excluded = getDescendants(moveTarget);
  excluded.add(moveTarget);

  const cats = Object.values(state.nodes)
    .filter(n => n.type === 'category' && !excluded.has(n.id))
    .filter(n => !q || n.name.toLowerCase().includes(q) || n.id === ROOT_ID)
    .sort((a, b) => {
      if (a.id === ROOT_ID) return -1;
      if (b.id === ROOT_ID) return 1;
      return a.name.localeCompare(b.name);
    });

  if (!cats.length) {
    const empty = el('div', 'search-empty'); empty.textContent = 'No categories found';
    listEl.appendChild(empty); return;
  }

  const currentParentId = state.nodes[moveTarget]?.parentId;

  cats.forEach(cat => {
    const isCurrent = cat.id === currentParentId;
    const row = el('div', `move-row${isCurrent ? ' move-current' : ''}`);

    const ico = el('div', 'item-ico cat'); ico.innerHTML = ICON_FOLDER; row.appendChild(ico);

    const info   = el('div', 'item-info');
    const nameEl = el('div', 'item-name');
    nameEl.textContent = cat.id === ROOT_ID ? '⌂ Home (root)' : cat.name;
    info.appendChild(nameEl);

    const pathStr = getNodePath(cat.id);
    if (pathStr) {
      const pathEl = el('div', 'search-path'); pathEl.textContent = pathStr; info.appendChild(pathEl);
    }

    if (isCurrent) {
      const tag = el('span', 'move-tag'); tag.textContent = 'current'; info.appendChild(tag);
    }

    row.appendChild(info);

    if (!isCurrent) {
      row.onclick = () => {
        if (categoryPickerCb) {
          const cb = categoryPickerCb; categoryPickerCb = null; moveTarget = null;
          closeModal('moveModal'); cb(cat.id);
        } else {
          moveNode(moveTarget, cat.id); closeModal('moveModal'); moveTarget = null;
        }
      };
    }

    listEl.appendChild(row);
  });
}

// ─── Schedule Modal ──────────────────────────────────────────────────────────
function openScheduleModal(itemId) {
  schedItemId = itemId;
  const node = state.nodes[itemId];
  const s = node.schedule;
  schedType = s?.type || 'once';
  schedDays = new Set(s?.days || []);

  $('schedDateInput').value = s?.date || todayStr();
  updateSchedTypeUI();

  openModal('scheduleModal');
}

function updateSchedTypeUI() {
  document.querySelectorAll('.sched-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === schedType));
  $('schedDateRow').style.display  = schedType === 'once'   ? 'block' : 'none';
  $('schedDaysRow').style.display  = schedType === 'weekly' ? 'flex'  : 'none';
  updateDayBtns();
}

function updateDayBtns() {
  document.querySelectorAll('.day-btn').forEach(b => b.classList.toggle('active', schedDays.has(+b.dataset.day)));
}

function submitSchedule() {
  const node = state.nodes[schedItemId]; if (!node) return;
  if (schedType === 'once') {
    const d = $('schedDateInput').value;
    if (!d) { shake('schedDateInput'); return; }
    node.schedule = { type: 'once', date: d };
  } else if (schedType === 'daily') {
    node.schedule = { type: 'daily' };
  } else {
    if (!schedDays.size) return;
    node.schedule = { type: 'weekly', days: [...schedDays].sort() };
  }
  node.done = false; node.doneDate = null; node.doneAt = null;
  save(); closeModal('scheduleModal'); render();
}

// ─── Track ───────────────────────────────────────────────────────────────────
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDuration(ms) {
  const totalMins = Math.floor(ms / 60000);
  const days  = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins  = totalMins % 60;
  const parts = [];
  if (days)  parts.push(`${days} day${days !== 1 ? 's' : ''}`);
  if (hours) parts.push(`${hours}h`);
  if (!days) parts.push(`${mins}m`);
  return parts.length ? parts.join(' ') : '0m';
}

function startRun() {
  if (!state.runs) state.runs = [];
  if (state.runs.find(r => !r.stoppedAt)) return;
  state.runs.push({ id: crypto.randomUUID(), startedAt: Date.now(), stoppedAt: null });
  save(); render();
}

function deleteRun(id) {
  state.runs = (state.runs || []).filter(r => r.id !== id);
  save(); render();
}

function stopRun() {
  const active = (state.runs || []).find(r => !r.stoppedAt);
  if (!active) return;
  active.stoppedAt = Date.now();
  save(); render();
}

function startTrackTick() {
  if (trackInterval) return;
  trackInterval = setInterval(() => {
    const active = (state.runs || []).find(r => !r.stoppedAt);
    if (!active || activeTab !== 'track') { clearTrackTick(); return; }
    const counter = document.getElementById('trackCounter');
    if (!counter) { clearTrackTick(); return; }
    const ms    = Date.now() - active.startedAt;
    const days  = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);
    const mins  = Math.floor((ms % 3600000) / 60000);
    const numEl = counter.querySelector('.track-days-num');
    const lblEl = counter.querySelector('.track-days-lbl');
    const hmsEl = counter.querySelector('.track-hms');
    if (numEl) numEl.textContent = days;
    if (lblEl) lblEl.textContent = days === 1 ? ' day' : ' days';
    if (hmsEl) hmsEl.textContent = `${hours}h ${mins}m`;
  }, 30000);
}

function clearTrackTick() {
  if (trackInterval) { clearInterval(trackInterval); trackInterval = null; }
}

function renderTrackTab() {
  $('emptyState').style.display = 'none';
  const listEl = $('itemList');
  if (!state.runs) state.runs = [];
  const active = state.runs.find(r => !r.stoppedAt);

  // Active / idle card
  const card = el('div', `track-card${active ? ' running' : ' idle'}`);

  if (active) {
    const ms    = Date.now() - active.startedAt;
    const days  = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);
    const mins  = Math.floor((ms % 3600000) / 60000);

    const dot = el('div', 'track-running-dot');
    dot.innerHTML = `<span class="track-dot-pulse">●</span> Running`;
    card.appendChild(dot);

    const counter = el('div', 'track-counter');
    counter.id = 'trackCounter';
    const daysRow = el('div', 'track-days');
    const daysNum = el('span', 'track-days-num'); daysNum.textContent = days;
    const daysLbl = el('span', 'track-days-lbl'); daysLbl.textContent = days === 1 ? ' day' : ' days';
    daysRow.appendChild(daysNum); daysRow.appendChild(daysLbl);
    const hmsEl = el('div', 'track-hms'); hmsEl.textContent = `${hours}h ${mins}m`;
    counter.appendChild(daysRow); counter.appendChild(hmsEl);
    card.appendChild(counter);

    const since = el('div', 'track-since');
    since.textContent = `Since ${fmtDate(active.startedAt)}`;
    card.appendChild(since);

    const stopBtn = el('button', 'track-stop-btn');
    stopBtn.textContent = 'Stop';
    stopBtn.onclick = stopRun;
    card.appendChild(stopBtn);

    startTrackTick();
  } else {
    const msgDiv = el('div', 'track-idle-msg');
    const icon = el('div', 'track-idle-icon'); icon.textContent = '⏱';
    const title = el('h2', 'track-idle-title'); title.textContent = 'Not tracking';
    const sub = el('p', 'track-idle-sub'); sub.textContent = 'Tap Start to begin counting from today';
    msgDiv.appendChild(icon); msgDiv.appendChild(title); msgDiv.appendChild(sub);
    card.appendChild(msgDiv);

    const startBtn = el('button', 'track-start-btn');
    startBtn.textContent = 'Start';
    startBtn.onclick = startRun;
    card.appendChild(startBtn);
  }

  listEl.appendChild(card);

  // History
  const allRuns = state.runs.map((r, i) => ({ run: r, num: i + 1 }));
  const stopped = allRuns.filter(({ run }) => run.stoppedAt).reverse();
  if (!stopped.length) return;

  const sec = el('div', 'track-history');
  const hdr = el('div', 'track-history-hdr'); hdr.textContent = 'History';
  sec.appendChild(hdr);

  stopped.forEach(({ run, num }) => {
    const ms  = run.stoppedAt - run.startedAt;
    const row = el('div', 'track-run-row');
    const numEl = el('div', 'track-run-num'); numEl.textContent = `#${num}`;
    const info  = el('div', 'track-run-info');
    const dur   = el('div', 'track-run-dur');   dur.textContent   = formatDuration(ms);
    const dates = el('div', 'track-run-dates'); dates.textContent = `${fmtDate(run.startedAt)} → ${fmtDate(run.stoppedAt)}`;
    info.appendChild(dur); info.appendChild(dates);
    const delBtn = el('button', 'track-run-del');
    delBtn.title = 'Delete';
    delBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
    delBtn.onclick = () => { if (confirm('Delete this run?')) deleteRun(run.id); };
    row.appendChild(numEl); row.appendChild(info); row.appendChild(delBtn);
    sec.appendChild(row);
  });

  listEl.appendChild(sec);
}

// ─── Event wiring ─────────────────────────────────────────────────────────────
function wireEvents() {
  // Lock screen
  $('lockSubmitBtn').onclick = submitLock;
  $('lockInput').onkeydown   = e => { if (e.key === 'Enter') submitLock(); };
  $('lockConfirm').onkeydown = e => { if (e.key === 'Enter') submitLock(); };

  // Security sheet (lock icon in header)
  $('secBtn').onclick       = () => openModal('secSheet');
  $('secLockBtn').onclick   = lockApp;
  $('secChangePwdBtn').onclick = () => { closeModal('secSheet'); openModal('changePasswordModal'); $('cpOld').value=''; $('cpNew').value=''; $('cpConfirm').value=''; $('cpError').textContent=''; setTimeout(()=>$('cpOld').focus(),300); };
  $('secCancelBtn').onclick = () => closeModal('secSheet');
  $('secSheet').onclick     = e => { if (e.target === $('secSheet')) closeModal('secSheet'); };

  // Change password modal
  $('cpSaveBtn').onclick    = submitChangePassword;
  $('cpCancelBtn').onclick  = () => closeModal('changePasswordModal');
  $('changePasswordModal').onclick = e => { if (e.target === $('changePasswordModal')) closeModal('changePasswordModal'); };

  // Back button
  $('backBtn').onclick = navBack;

  // FAB
  $('fab').onclick = openAddModal;

  // Add Modal
  $('typeCatBtn').onclick = () => { addType='category'; $('typeCatBtn').classList.add('active'); $('typeItemBtn').classList.remove('active'); };
  $('typeItemBtn').onclick = () => { addType='item'; $('typeItemBtn').classList.add('active'); $('typeCatBtn').classList.remove('active'); };
  $('addCancelBtn').onclick = () => closeModal('addModal');
  $('addSaveBtn').onclick   = submitAdd;
  $('addInput').onkeydown   = e => { if (e.key==='Enter') submitAdd(); if (e.key==='Escape') closeModal('addModal'); };
  $('addModal').onclick     = e => { if (e.target===$('addModal')) closeModal('addModal'); };

  // Add Link Modal
  $('linkUrlInput').oninput    = e => onLinkUrlInput(e.target.value);
  $('addLinkSaveBtn').onclick  = submitAddLink;
  $('addLinkCancelBtn').onclick = () => { closeModal('addLinkModal'); addLinkItemId = null; };
  $('addLinkModal').onclick    = e => { if (e.target === $('addLinkModal')) { closeModal('addLinkModal'); addLinkItemId = null; } };
  $('linkUrlInput').onkeydown  = e => { if (e.key === 'Enter') { $('linkNameInput').focus(); } if (e.key === 'Escape') { closeModal('addLinkModal'); addLinkItemId = null; } };
  $('linkNameInput').onkeydown = e => { if (e.key === 'Enter') submitAddLink(); if (e.key === 'Escape') { closeModal('addLinkModal'); addLinkItemId = null; } };

  // Rename Modal
  $('renameCancelBtn').onclick = () => { closeModal('renameModal'); renameLinkTarget = null; renameTarget = null; };
  $('renameSaveBtn').onclick   = submitRename;
  $('renameInput').onkeydown   = e => { if (e.key==='Enter') submitRename(); if (e.key==='Escape') closeModal('renameModal'); };
  $('renameModal').onclick     = e => { if (e.target===$('renameModal')) closeModal('renameModal'); };

  // Context Menu
  $('ctxRename').onclick = () => { const id=ctxTarget; closeCtxMenu(); openRenameModal(id); };
  $('ctxMove').onclick   = () => { const id=ctxTarget; closeCtxMenu(); openMoveModal(id); };

  // Move Modal
  $('moveSearch').oninput    = e => populateMoveList(e.target.value);
  $('moveCancelBtn').onclick  = () => { closeModal('moveModal'); moveTarget = null; categoryPickerCb = null; };
  $('moveModal').onclick      = e => { if (e.target === $('moveModal')) { closeModal('moveModal'); moveTarget = null; categoryPickerCb = null; } };

  // Share Modal
  $('shareDestBtn').onclick  = () => {
    categoryPickerCb = id => { shareCategoryId = id; updateShareDest(); openModal('shareModal'); setTimeout(() => $('shareNameInput').focus(), 300); };
    moveTarget = null;
    $('moveTitle').textContent = 'Save to…';
    $('moveSearch').value = '';
    populateMoveList('');
    closeModal('shareModal');
    openModal('moveModal');
  };
  $('shareSaveBtn').onclick   = saveSharedItem;
  $('shareCancelBtn').onclick = () => closeModal('shareModal');
  $('shareModal').onclick     = e => { if (e.target === $('shareModal')) closeModal('shareModal'); };
  $('shareNameInput').onkeydown = e => { if (e.key === 'Enter') saveSharedItem(); if (e.key === 'Escape') closeModal('shareModal'); };
  $('ctxDelete').onclick = () => {
    const id=ctxTarget, node=state.nodes[id]; closeCtxMenu(); if (!node) return;
    let msg = `Delete "${node.name}"?`;
    if (node.type==='category' && childCount(node)>0) msg=`Delete "${node.name}" and all its contents?\n\nThis cannot be undone.`;
    if (confirm(msg)) deleteNode(id);
  };
  $('backdrop').onclick = closeCtxMenu;

  // Schedule Modal
  document.querySelectorAll('.sched-type-btn').forEach(b => {
    b.onclick = () => { schedType = b.dataset.type; updateSchedTypeUI(); };
  });
  document.querySelectorAll('.day-btn').forEach(b => {
    b.onclick = () => { const d = +b.dataset.day; schedDays.has(d) ? schedDays.delete(d) : schedDays.add(d); updateDayBtns(); };
  });
  $('schedSaveBtn').onclick   = submitSchedule;
  $('schedCancelBtn').onclick = () => closeModal('scheduleModal');
  $('scheduleModal').onclick  = e => { if (e.target === $('scheduleModal')) closeModal('scheduleModal'); };

  // Search
  $('searchBtn').onclick      = openSearch;
  $('searchCloseBtn').onclick = closeSearch;
  $('searchInput').oninput    = e => performSearch(e.target.value);
  $('searchInput').onkeydown  = e => { if (e.key==='Escape') closeSearch(); };

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeCtxMenu(); closeSearch(); closeModal('secSheet'); }
    if (e.key === 'Backspace' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) {
      e.preventDefault(); navBack();
    }
  });

  document.addEventListener('touchmove', e => {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
}

// ─── Service Worker ───────────────────────────────────────────────────────────
function registerSW() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function init() {
  $('backBtn').innerHTML = ICON_BACK;
  $('secBtn').innerHTML  = ICON_LOCK;
  checkSharedContent();
  wireEvents();
  registerSW();

  const hasPassword = !!localStorage.getItem(SALT_KEY);
  const hasLegacy   = !!localStorage.getItem(LEGACY_KEY);

  if (!hasPassword) {
    showLockScreen('setup');
    // Pre-load legacy data into state so it gets migrated on password setup
    if (hasLegacy) {
      try {
        const parsed = JSON.parse(localStorage.getItem(LEGACY_KEY));
        if (parsed?.nodes && parsed?.path) { state = parsed; sanitizePath(); }
      } catch (_) {}
    }
  } else {
    showLockScreen('unlock');
  }
}

document.addEventListener('DOMContentLoaded', init);
