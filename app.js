'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────
const STORAGE_KEY = 'hierarchyApp_v2';
const ROOT_ID = 'root';

// ─── State ───────────────────────────────────────────────────────────────────
let state = {
  nodes: {
    [ROOT_ID]: {
      id: ROOT_ID,
      name: 'My Hierarchy',
      type: 'category',
      parentId: null,
      children: [],
      createdAt: Date.now()
    }
  },
  path: [ROOT_ID]   // navigation stack (array of IDs)
};

let ctxTarget = null;   // ID of node the context menu is open for
let drag = { active: false, id: null, ghost: null, source: null, lastTarget: null };

// ─── Persistence ─────────────────────────────────────────────────────────────
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved?.nodes && saved?.path) {
      state = saved;
      if (!state.nodes[ROOT_ID]) {
        state.nodes[ROOT_ID] = { id: ROOT_ID, name: 'My Hierarchy', type: 'category', parentId: null, children: [], createdAt: Date.now() };
        state.path = [ROOT_ID];
      }
      // Sanitize path — drop any IDs that no longer exist
      state.path = state.path.filter(id => state.nodes[id]);
      if (!state.path.length) state.path = [ROOT_ID];
    }
  } catch (_) {}
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
}

// ─── Queries ─────────────────────────────────────────────────────────────────
const current = () => state.nodes[state.path[state.path.length - 1]];

function childCount(node) {
  return node.type === 'category' ? (node.children?.length ?? 0) : 0;
}

// ─── Mutations ───────────────────────────────────────────────────────────────
function addNode(name, type) {
  const parent = current();
  const id = crypto.randomUUID();
  const node = { id, name: name.trim(), type, parentId: parent.id, createdAt: Date.now() };
  if (type === 'category') node.children = [];
  if (type === 'item') node.notes = '';
  state.nodes[id] = node;
  parent.children.push(id);
  save(); render();
}

function renameNode(id, name) {
  if (state.nodes[id]) { state.nodes[id].name = name.trim(); save(); render(); }
}

// Delete node and all descendants
function deleteNode(id) {
  _deleteTree(id);
  save();
  // Fix path if we deleted something we were inside
  const idx = state.path.indexOf(id);
  if (idx !== -1) {
    state.path = state.path.slice(0, Math.max(1, idx));
  }
  render();
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
function navBack()   { if (state.path.length > 1) { state.path.pop(); render(); } }
function navTo(idx)  { state.path = state.path.slice(0, idx + 1); render(); }

// ─── Render ──────────────────────────────────────────────────────────────────
function render() {
  const node = current();
  const isDetail = node.type === 'item';
  renderHeader();
  renderBreadcrumb();
  $('fab').style.display = isDetail ? 'none' : 'flex';
  if (isDetail) renderItemDetail(node);
  else renderList();
}

function renderItemDetail(node) {
  $('emptyState').style.display = 'none';
  const listEl = $('itemList');
  listEl.innerHTML = '';

  const editor = el('div', 'notes-editor');

  const textarea = el('textarea', 'notes-textarea');
  textarea.placeholder = 'Write your notes here…';
  textarea.value = node.notes || '';
  textarea.setAttribute('aria-label', 'Notes for ' + node.name);

  const status = el('div', 'save-status');

  let saveTimer;
  textarea.oninput = () => {
    clearTimeout(saveTimer);
    status.textContent = '';
    saveTimer = setTimeout(() => {
      node.notes = textarea.value;
      save();
      status.textContent = '✓ Saved';
      setTimeout(() => { status.textContent = ''; }, 1500);
    }, 600);
  };

  editor.appendChild(textarea);
  editor.appendChild(status);
  listEl.appendChild(editor);
  setTimeout(() => textarea.focus(), 150);
}

function renderHeader() {
  const node = current();
  const atRoot = state.path.length === 1;
  $('backBtn').style.display = atRoot ? 'none' : 'flex';
  $('headerTitle').textContent = node.name;
}

function renderBreadcrumb() {
  const bc = $('breadcrumb');
  bc.innerHTML = '';
  state.path.forEach((id, i) => {
    const node = state.nodes[id];
    if (!node) return;
    if (i > 0) {
      const sep = el('span', 'bc-sep'); sep.textContent = '›'; bc.appendChild(sep);
    }
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
  const node = current();
  const emptyEl = $('emptyState');
  const listEl  = $('itemList');

  const kids = (node.children ?? []).map(id => state.nodes[id]).filter(Boolean);

  if (!kids.length) {
    emptyEl.style.display = 'block';
    listEl.innerHTML = '';
    return;
  }

  emptyEl.style.display = 'none';
  listEl.innerHTML = '';

  kids.forEach((n, i) => {
    const li   = el('li');
    const card = makeCard(n, i);
    li.appendChild(card);
    listEl.appendChild(li);
  });
}

function makeCard(node, idx) {
  const isCat = node.type === 'category';

  const card = el('div', 'item-card');
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
  const info = el('div', 'item-info');
  const nameEl = el('div', 'item-name');
  nameEl.textContent = node.name;
  info.appendChild(nameEl);
  if (isCat) {
    const meta = el('div', 'item-meta');
    const c = childCount(node);
    meta.textContent = c === 0 ? 'Empty' : `${c} ${c === 1 ? 'item' : 'items'}`;
    info.appendChild(meta);
  } else if (node.notes?.trim()) {
    const meta = el('div', 'item-meta notes-preview');
    meta.textContent = node.notes.split('\n')[0].slice(0, 70);
    info.appendChild(meta);
  }
  card.appendChild(info);

  // Chevron for all (categories navigate in, items open notes)
  const chev = el('div', 'item-chevron');
  chev.innerHTML = ICON_CHEV;
  card.appendChild(chev);

  // More button
  const moreBtn = el('button', 'item-more');
  moreBtn.setAttribute('aria-label', 'More options');
  moreBtn.innerHTML = ICON_DOTS;
  moreBtn.onclick = e => { e.stopPropagation(); openCtxMenu(e, node.id); };
  card.appendChild(moreBtn);

  // All cards navigate on click (ignore handle and more-btn)
  card.addEventListener('click', e => {
    if (e.target.closest('.item-more') || e.target.closest('.drag-handle')) return;
    navInto(node.id);
  });

  // Long-press → context menu (mobile)
  let lpTimer;
  card.addEventListener('touchstart', e => {
    if (e.target.closest('.item-more')) return;
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
  const fromIdx = children.indexOf(dragId);
  if (fromIdx === -1) return;
  children.splice(fromIdx, 1);
  const toIdx = children.indexOf(targetId);
  children.splice(insertBefore ? toIdx : toIdx + 1, 0, dragId);
  save(); render();
}

function clearDropIndicators() {
  document.querySelectorAll('.drop-above, .drop-below')
    .forEach(el => el.classList.remove('drop-above', 'drop-below'));
}

function startDrag(e, card, nodeId) {
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();

  const startX = e.clientX, startY = e.clientY;
  const rect = card.getBoundingClientRect();
  let activated = false;

  function activate() {
    activated = true;
    drag.active = true;
    drag.id = nodeId;
    drag.source = card;
    drag.offsetY = startY - rect.top;

    const g = card.cloneNode(true);
    g.className = 'item-card drag-ghost';
    Object.assign(g.style, { width: rect.width + 'px', top: rect.top + 'px', left: rect.left + 'px' });
    document.body.appendChild(g);
    drag.ghost = g;
    card.classList.add('drag-source');
  }

  function move(ev) {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (!activated && Math.hypot(dx, dy) < 6) return;
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
    } else {
      drag.lastTarget = null;
    }
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

  // Position
  const mw = 180, mh = 110;
  const left = Math.max(8, Math.min(x - mw, window.innerWidth - mw - 8));
  const top  = (y + mh > window.innerHeight - 8) ? y - mh - 4 : y + 4;
  menu.style.left = `${left}px`;
  menu.style.top  = `${top}px`;
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
  renameNode(renameTarget, name);
  closeModal('renameModal');
  renameTarget = null;
}

// ─── Modal helpers ────────────────────────────────────────────────────────────
function openModal(id)  { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }

function shake(inputId) {
  const inp = $(inputId);
  inp.classList.remove('shake');
  void inp.offsetWidth;   // force reflow
  inp.classList.add('shake');
  inp.focus();
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

// ─── SVG Icons ───────────────────────────────────────────────────────────────
const ICON_FOLDER = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
  <path d="M10 4H4c-1.11 0-2 .89-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.11-.89-2-2-2h-8l-2-2z"/>
</svg>`;

const ICON_ITEM = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
  <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
</svg>`;

const ICON_CHEV = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
  <path d="M8.59 16.58L13.17 12 8.59 7.41 10 6l6 6-6 6z"/>
</svg>`;

const ICON_DOTS = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
  <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
</svg>`;

const ICON_DRAG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
  <circle cx="9" cy="5" r="2"/><circle cx="15" cy="5" r="2"/>
  <circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>
  <circle cx="9" cy="19" r="2"/><circle cx="15" cy="19" r="2"/>
</svg>`;

const ICON_BACK = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
  <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
</svg>`;

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
      (n.notes?.toLowerCase().includes(q))
    )
  );

  if (!matches.length) {
    const empty = el('div', 'search-empty');
    empty.textContent = 'No results found';
    resultsEl.appendChild(empty);
    return;
  }

  matches.slice(0, 60).forEach(node => {
    const isCat = node.type === 'category';
    const row = el('div', 'search-result');

    const ico = el('div', `item-ico ${isCat ? 'cat' : 'leaf'} search-ico`);
    ico.innerHTML = isCat ? ICON_FOLDER : ICON_ITEM;
    row.appendChild(ico);

    const info = el('div', 'item-info');
    const nameEl = el('div', 'item-name');
    nameEl.innerHTML = highlight(node.name, q);
    info.appendChild(nameEl);

    const pathStr = getNodePath(node.id);
    if (pathStr) {
      const pathEl = el('div', 'search-path');
      pathEl.textContent = pathStr;
      info.appendChild(pathEl);
    }

    if (!isCat && node.notes?.trim()) {
      const noteMatch = findNoteSnippet(node.notes, q);
      if (noteMatch) {
        const snip = el('div', 'search-snippet');
        snip.innerHTML = noteMatch;
        info.appendChild(snip);
      }
    }

    row.appendChild(info);
    const chev = el('div', 'item-chevron');
    chev.innerHTML = ICON_CHEV;
    row.appendChild(chev);

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
  const node = state.nodes[id];
  if (!node) return;
  const pathIds = [];
  let cur = node;
  while (cur) { pathIds.unshift(cur.id); if (!cur.parentId) break; cur = state.nodes[cur.parentId]; }
  state.path = pathIds;
  render();
}

function highlight(text, q) {
  const i = text.toLowerCase().indexOf(q);
  if (i === -1) return escapeHtml(text);
  return escapeHtml(text.slice(0, i)) +
    `<mark>${escapeHtml(text.slice(i, i + q.length))}</mark>` +
    escapeHtml(text.slice(i + q.length));
}

function findNoteSnippet(notes, q) {
  const lower = notes.toLowerCase();
  const i = lower.indexOf(q);
  if (i === -1) return null;
  const start = Math.max(0, i - 30);
  const end   = Math.min(notes.length, i + q.length + 50);
  const raw   = (start > 0 ? '…' : '') + notes.slice(start, end).replace(/\n/g, ' ') + (end < notes.length ? '…' : '');
  return highlight(raw, q);
}

// ─── Event wiring ─────────────────────────────────────────────────────────────
function wireEvents() {
  // Search
  $('searchBtn').onclick   = openSearch;
  $('searchCloseBtn').onclick = closeSearch;
  $('searchInput').oninput = e => performSearch(e.target.value);
  $('searchInput').addEventListener('keydown', e => { if (e.key === 'Escape') closeSearch(); });

  // Back button
  $('backBtn').onclick = navBack;

  // FAB
  $('fab').onclick = openAddModal;

  // Add Modal – type toggle
  $('typeCatBtn').onclick = () => {
    addType = 'category';
    $('typeCatBtn').classList.add('active');
    $('typeItemBtn').classList.remove('active');
  };
  $('typeItemBtn').onclick = () => {
    addType = 'item';
    $('typeItemBtn').classList.add('active');
    $('typeCatBtn').classList.remove('active');
  };

  $('addCancelBtn').onclick = () => closeModal('addModal');
  $('addSaveBtn').onclick   = submitAdd;
  $('addInput').onkeydown   = e => { if (e.key === 'Enter') submitAdd(); if (e.key === 'Escape') closeModal('addModal'); };
  $('addModal').onclick     = e => { if (e.target === $('addModal')) closeModal('addModal'); };

  // Rename Modal
  $('renameCancelBtn').onclick = () => closeModal('renameModal');
  $('renameSaveBtn').onclick   = submitRename;
  $('renameInput').onkeydown   = e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') closeModal('renameModal'); };
  $('renameModal').onclick     = e => { if (e.target === $('renameModal')) closeModal('renameModal'); };

  // Context Menu
  $('ctxRename').onclick = () => {
    const id = ctxTarget;
    closeCtxMenu();
    openRenameModal(id);
  };

  $('ctxDelete').onclick = () => {
    const id = ctxTarget;
    const node = state.nodes[id];
    closeCtxMenu();
    if (!node) return;

    let msg = `Delete "${node.name}"?`;
    if (node.type === 'category' && childCount(node) > 0) {
      msg = `Delete "${node.name}" and all its contents?\n\nThis cannot be undone.`;
    }
    if (confirm(msg)) deleteNode(id);
  };

  // Backdrop closes context menu
  $('backdrop').onclick = closeCtxMenu;

  // Keyboard
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeCtxMenu(); closeSearch(); }
    if (e.key === 'Backspace' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
      e.preventDefault();
      navBack();
    }
  });

  // Prevent pinch zoom on mobile (optional, good for app-feel)
  document.addEventListener('touchmove', e => {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
}

// ─── Service Worker ───────────────────────────────────────────────────────────
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  $('backBtn').innerHTML = ICON_BACK;
  load();
  wireEvents();
  render();
  registerSW();
});
