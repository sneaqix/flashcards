import { GitHub, isConflict } from './github.js?v=20261029215054';
import * as S from './store.js?v=20261029215054';

const $ = (id) => document.getElementById(id);
const TABS = ['reviser', 'bachotage', 'cartes', 'stats', 'parametres'];

const state = {
  matieres: [],          // [{ id, nom, chapitres: [chapter] }]
  chapters: [],          // tous les chapitres
  byId: new Map(),
  progress: S.loadProgress(),
  config: S.loadConfig(),
  gh: null,
  session: null,
  lastMode: 'srs',
  syncing: false,
  syncAgain: false,
  imgCache: new Map(),   // images ajoutées pendant cette visite (avant mise à jour du site)
  editChapterId: null,
  edit: null,
  cramSel: new Set(),
  discardUntil: 0,       // délai pendant lequel on peut abandonner des modifications non enregistrées
};

// =====================================================================
// Outils
// =====================================================================
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function typeset(...els) {
  if (!window.MathJax || !MathJax.typesetPromise) return;
  if (MathJax.typesetClear) MathJax.typesetClear(els);
  MathJax.typesetPromise(els).catch(() => {});
}
function imageUrl(path) {
  return state.imgCache.get(path) || path;
}
function renderFace(el, text, img) {
  el.innerHTML = escapeHtml(text || '').replace(/\n/g, '<br>');
  if (img) {
    const im = new Image();
    im.alt = '';
    im.src = imageUrl(img);
    el.appendChild(im);
  }
  typeset(el);
}
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}
function setStatus(id, msg, kind = '') {
  const el = $(id);
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
}
function plural(n, one, many) { return n + ' ' + (n > 1 ? many : one); }
function saveProgress() { S.saveProgress(state.progress); }
function activeChapters() {
  const off = new Set(state.progress.settings.inactive || []);
  return state.chapters.filter((c) => !off.has(c.id));
}
function chapterCounts(ch) {
  const counts = [0, 0, 0, 0, 0, 0];
  ch.cartes.forEach((card) => {
    const st = S.cardState(state.progress, ch, card);
    counts[st ? st.box : 0]++;
  });
  return counts;
}
function canSync() { return !!(state.gh && state.config.dataRepo); }
function canEdit() { return !!(state.gh && state.config.contentRepo); }
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// =====================================================================
// Chargement des cartes
// =====================================================================
async function loadDecks() {
  const { gh, config } = state;
  let index = null;
  let viaApi = false;
  if (gh && config.contentRepo) {
    try {
      const f = await gh.getFile(config.contentRepo, 'decks/index.json');
      if (f) { index = JSON.parse(f.text); viaApi = true; }
    } catch (e) { console.warn('Lecture via GitHub impossible, repli sur le site', e); }
  }
  if (!index) {
    const res = await fetch('decks/index.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('index.json introuvable');
    index = await res.json();
  }
  const matieres = await Promise.all(index.matieres.map(async (m) => {
    const chapitres = await Promise.all(m.chapitres.map(async (file) => {
      try {
        let data = null, sha = null;
        if (viaApi) {
          const f = await gh.getFile(config.contentRepo, 'decks/' + file);
          if (f) { data = JSON.parse(f.text); sha = f.sha; }
        } else {
          const res = await fetch('decks/' + file, { cache: 'no-store' });
          if (res.ok) data = await res.json();
        }
        if (!data) return null;
        return { id: data.id, nom: data.nom, cartes: data.cartes || [], matiere: m.id, matiereNom: m.nom, file, sha };
      } catch (e) {
        console.warn('Chapitre illisible : ' + file, e);
        return null;
      }
    }));
    return { id: m.id, nom: m.nom, chapitres: chapitres.filter(Boolean) };
  }));
  state.matieres = matieres;
  state.chapters = matieres.flatMap((m) => m.chapitres);
  state.byId = new Map(state.chapters.map((c) => [c.id, c]));
}

// =====================================================================
// Navigation
// =====================================================================
function showView(name) {
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + name; });
  const tab = name === 'carte' ? 'cartes' : name;
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  document.body.classList.toggle('in-session', name === 'session' || name === 'done');
  window.scrollTo(0, 0);
}
function currentTab() {
  const h = location.hash.slice(1);
  return TABS.includes(h) ? h : 'reviser';
}
function route() {
  if (state.session) return;
  const tab = currentTab();
  ({ reviser: renderHome, bachotage: renderCram, cartes: renderCartes, stats: renderStats, parametres: renderSettings })[tab]();
  showView(tab);
}
// Rafraîchit la vue affichée après une synchronisation, sauf si l'utilisateur est en train de réviser ou d'écrire.
function refreshIfIdle() {
  if (state.session || !$('view-carte').hidden || !$('view-done').hidden) return;
  if (currentTab() === 'parametres' && document.activeElement && document.activeElement.matches('input')) return;
  route();
}

// =====================================================================
// Accueil : révision du jour
// =====================================================================
// Nom d'une boîte de Leitner d'après son intervalle de révision : N (jamais vue), j1, j2, j4, j8, j16.
function boxLabel(box) { return box > 0 ? 'j' + S.INTERVALS[box - 1] : 'N'; }
function boxesHtml(counts) {
  const max = Math.max(1, ...counts);
  return '<div class="boxes">' + counts.map((n, i) =>
    '<div class="box" title="' + (i === 0 ? 'Jamais vues' : 'Reviennent après ' + S.INTERVALS[i - 1] + ' j') + ' : ' + n + '">' +
    '<div class="bar"><div class="fill" style="height:' + Math.round(n / max * 100) + '%"></div></div>' +
    '<span>' + boxLabel(i) + '·' + n + '</span></div>').join('') + '</div>';
}

function renderHome() {
  const p = state.progress;
  $('date').textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const daily = S.dailyQueue(p, activeChapters());
  $('dueTotal').textContent = daily.items.length;
  $('dueDetail').textContent = plural(daily.reviewsDue, 'révision', 'révisions') + ' · ' + plural(daily.newAvailable, 'nouvelle', 'nouvelles');
  $('startDaily').disabled = daily.items.length === 0;

  const off = new Set(p.settings.inactive || []);
  const list = $('chapterList');
  list.innerHTML = '';
  if (!state.chapters.length) {
    list.innerHTML = '<p class="sub">Aucun chapitre pour l\'instant.</p>';
    return;
  }
  state.matieres.forEach((m) => {
    if (!m.chapitres.length) return;
    const total = m.chapitres.reduce((s, c) => s + c.cartes.length, 0);
    const sec = document.createElement('div');
    sec.className = 'matiere';
    const activeHere = m.chapitres.filter((c) => !off.has(c.id));
    const sub = daily.bySubject[m.id] || { reviews: 0, fresh: 0, total: 0 };
    sec.innerHTML = '<div class="matiere-head"><div><h2></h2><span>' + plural(total, 'carte', 'cartes') + ' · ' +
      sub.reviews + ' à revoir · ' + plural(sub.fresh, 'nouvelle', 'nouvelles') + '</span></div>' +
      '<button class="primary small subject-start" type="button">Réviser · ' + sub.total + '</button></div><ul class="chapters"></ul>';
    sec.querySelector('h2').textContent = m.nom;
    const subjectBtn = sec.querySelector('.subject-start');
    subjectBtn.disabled = sub.total === 0;
    subjectBtn.setAttribute('aria-label', 'Réviser ' + m.nom + ' : ' + plural(sub.total, 'carte', 'cartes'));
    subjectBtn.addEventListener('click', () => startSession(S.dailyQueue(state.progress, activeHere).items, 'srs', m.nom));
    const ul = sec.querySelector('ul');
    m.chapitres.forEach((ch) => {
      const q = S.dailyQueue(p, [ch]);
      const li = document.createElement('li');
      li.className = 'chapter' + (off.has(ch.id) ? ' inactive' : '');
      li.innerHTML = '<div><h3></h3><div class="due"><b>' + q.items.length + '</b> à faire · ' +
        plural(ch.cartes.length, 'carte', 'cartes') + (off.has(ch.id) ? ' · hors révision du jour' : '') + '</div></div>' +
        '<button class="primary small" type="button">Réviser</button>' + boxesHtml(chapterCounts(ch));
      li.querySelector('h3').textContent = ch.nom;
      const btn = li.querySelector('button');
      btn.disabled = q.items.length === 0;
      btn.addEventListener('click', () => startSession(S.dailyQueue(state.progress, [ch]).items, 'srs', ch.nom));
      ul.appendChild(li);
    });
    list.appendChild(sec);
  });
}

// =====================================================================
// Session de révision (Leitner ou bachotage)
// =====================================================================
function startSession(items, mode, label) {
  if (!items.length) { toast('Rien à réviser ici pour aujourd\'hui.'); return; }
  state.session = { mode, queue: items.slice(), total: items.length, done: 0, firstTry: 0, missed: new Set(), seen: new Set(), history: [] };
  state.finished = null;
  state.lastMode = mode;
  $('modeLabel').textContent = mode === 'cram' ? 'Bachotage' : label;
  showView('session');
  nextCard();
}
function nextCard() {
  const s = state.session;
  if (!s.queue.length) return finishSession();
  const { chapter, card } = s.queue[0];
  $('cardTag').textContent = chapter.matiereNom + ' · ' + chapter.nom;
  renderFace($('question'), card.q, card.img_q);
  $('answer').hidden = true;
  $('answer').innerHTML = '';
  $('show').hidden = false;
  $('grade').hidden = true;
  $('counter').textContent = Math.min(s.done + 1, s.total) + ' / ' + s.total;
  $('progressBar').style.width = (s.done / s.total * 100) + '%';
  $('undo').hidden = !s.history.length;
  $('show').focus({ preventScroll: true });
}
function reveal() {
  const s = state.session;
  if (!s || !$('answer').hidden) return;
  const { card } = s.queue[0];
  renderFace($('answer'), card.r, card.img_r);
  $('answer').hidden = false;
  $('show').hidden = true;
  $('grade').hidden = false;
}
function grade(knew) {
  const s = state.session;
  if (!s || $('answer').hidden) return;
  // État de la session avant cette réponse, pour pouvoir revenir en arrière.
  const snapshot = {
    queue: s.queue.slice(), done: s.done, firstTry: s.firstTry,
    missed: new Set(s.missed), seen: new Set(s.seen), undo: null,
  };
  const item = s.queue.shift();
  const key = S.cardKey(item.chapter, item.card);
  const first = !s.seen.has(key);
  s.seen.add(key);
  if (s.mode === 'srs') {
    snapshot.undo = S.recordAnswer(state.progress, item, knew, first);
    saveProgress();
    scheduleSync(20000); // sauvegarde régulière pendant une longue session
  }
  s.history.push(snapshot);
  if (s.history.length > 50) s.history.shift();
  if (knew) {
    s.done++;
    if (!s.missed.has(key)) s.firstTry++;
  } else {
    s.missed.add(key);
    s.queue.push(item); // la carte revient en fin de session
  }
  nextCard();
}
function finishSession() {
  const s = state.session;
  $('doneText').textContent = plural(s.total, 'carte révisée', 'cartes révisées') + ', ' +
    plural(s.firstTry, 'sue', 'sues') + ' du premier coup.' +
    (s.mode === 'cram' ? ' Ta progression Leitner n\'a pas été modifiée.' : '');
  state.finished = s; // permet encore d'annuler la dernière réponse depuis l'écran de fin
  $('doneUndo').hidden = !s.history.length;
  state.session = null;
  if (state.lastMode === 'srs') scheduleSync(0);
  showView('done');
  $('back').focus({ preventScroll: true });
}
// Revient à la carte précédente : annule la dernière réponse et réaffiche la carte, réponse visible.
function undoLast() {
  if (!state.session && state.finished) {
    state.session = state.finished;
    state.finished = null;
    showView('session');
  }
  const s = state.session;
  if (!s || !s.history.length) return;
  const snap = s.history.pop();
  if (snap.undo) {
    S.undoAnswer(state.progress, snap.undo);
    saveProgress();
    scheduleSync(20000);
  }
  s.queue = snap.queue;
  s.done = snap.done;
  s.firstTry = snap.firstTry;
  s.missed = snap.missed;
  s.seen = snap.seen;
  nextCard();
  reveal();
  toast('Réponse annulée : choisis à nouveau.');
}
function leaveSession() {
  const wasSrs = state.session && state.session.mode === 'srs';
  state.session = null;
  state.finished = null;
  if (wasSrs) scheduleSync(0);
  const target = state.lastMode === 'cram' ? 'bachotage' : 'reviser';
  if (location.hash.slice(1) !== target) location.hash = target;
  else route();
}

// =====================================================================
// Listes de chapitres à cocher (bachotage et réglages)
// =====================================================================
function buildChecklist(container, isChecked, onChange) {
  container.innerHTML = '';
  state.matieres.forEach((m) => {
    if (!m.chapitres.length) return;
    const g = document.createElement('div');
    g.className = 'checkgroup';
    const all = document.createElement('label');
    all.className = 'check';
    const allBox = document.createElement('input');
    allBox.type = 'checkbox';
    allBox.id = container.id + '-' + m.id;
    all.append(allBox, document.createTextNode(m.nom));
    const items = document.createElement('div');
    items.className = 'items';
    const boxes = m.chapitres.map((ch) => {
      const l = document.createElement('label');
      l.className = 'check';
      const b = document.createElement('input');
      b.type = 'checkbox';
      b.id = container.id + '-' + ch.id;
      b.checked = isChecked(ch);
      b.addEventListener('change', () => { onChange([ch], b.checked); sync(); });
      l.append(b, document.createTextNode(ch.nom + ' (' + ch.cartes.length + ')'));
      items.appendChild(l);
      return b;
    });
    function sync() {
      const n = boxes.filter((b) => b.checked).length;
      allBox.checked = n === boxes.length;
      allBox.indeterminate = n > 0 && n < boxes.length;
    }
    allBox.addEventListener('change', () => {
      boxes.forEach((b) => { b.checked = allBox.checked; });
      onChange(m.chapitres, allBox.checked);
      sync();
    });
    sync();
    g.append(all, items);
    container.appendChild(g);
  });
}

// =====================================================================
// Bachotage
// =====================================================================
function cramPool() {
  const hard = $('cramHard').checked;
  const pool = [];
  state.chapters.forEach((ch) => {
    if (!state.cramSel.has(ch.id)) return;
    ch.cartes.forEach((card) => {
      const st = S.cardState(state.progress, ch, card);
      if (hard && st && st.box > 2) return;
      pool.push({ chapter: ch, card, isNew: !st });
    });
  });
  return pool;
}
function updateCramInfo() {
  const n = cramPool().length;
  const max = Number($('cramCount').value) || n;
  $('cramInfo').textContent = n ? plural(n, 'carte disponible', 'cartes disponibles') + ', ' + Math.min(n, max) + ' au programme.' : 'Coche au moins un chapitre.';
  $('startCram').disabled = n === 0;
}
function renderCram() {
  buildChecklist($('cramChapters'), (ch) => state.cramSel.has(ch.id), (chs, on) => {
    chs.forEach((ch) => (on ? state.cramSel.add(ch.id) : state.cramSel.delete(ch.id)));
    updateCramInfo();
  });
  updateCramInfo();
}
function startCram() {
  const pool = S.shuffle(cramPool());
  const n = Number($('cramCount').value) || pool.length;
  startSession(pool.slice(0, n), 'cram');
}

// =====================================================================
// Éditeur de cartes
// =====================================================================
function renderCartes() {
  const locked = !canEdit();
  $('editorLocked').hidden = !locked;
  $('newCard').disabled = locked;
  $('newChapter').disabled = locked;
  if (!state.byId.has(state.editChapterId)) state.editChapterId = state.chapters[0] ? state.chapters[0].id : null;
  const sel = $('editChapter');
  sel.innerHTML = '';
  state.matieres.forEach((m) => {
    if (!m.chapitres.length) return;
    const og = document.createElement('optgroup');
    og.label = m.nom;
    m.chapitres.forEach((ch) => {
      const o = document.createElement('option');
      o.value = ch.id;
      o.textContent = ch.nom + ' (' + ch.cartes.length + ')';
      og.appendChild(o);
    });
    sel.appendChild(og);
  });
  sel.value = state.editChapterId || '';
  const ncm = $('ncMatiere');
  ncm.innerHTML = state.matieres.map((m) => '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.nom) + '</option>').join('');
  renderCardList();
}
function renderCardList() {
  const ul = $('cardList');
  ul.innerHTML = '';
  const ch = state.byId.get(state.editChapterId);
  if (!ch) return;
  const term = $('cardSearch').value.trim();
  const cards = visibleCards(ch);
  if (!cards.length) {
    ul.innerHTML = '<li class="empty">' + (term ? 'Aucune carte ne correspond.' : 'Ce chapitre est vide. Ajoute ta première carte.') + '</li>';
    return;
  }
  cards.forEach((card) => {
    const st = S.cardState(state.progress, ch, card);
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = '<span class="q"></span><span class="meta">' + boxLabel(st ? st.box : 0) + (card.img_q || card.img_r ? ' · img' : '') + '</span>';
    b.querySelector('.q').innerHTML = escapeHtml(card.q);
    b.addEventListener('click', () => openEditor(ch, card));
    li.appendChild(b);
    ul.appendChild(li);
  });
  typeset(ul);
}

// Cartes du chapitre affichées dans la liste (filtrées par la recherche) : c'est l'ordre de défilement.
function visibleCards(ch) {
  const term = $('cardSearch').value.trim().toLowerCase();
  return ch.cartes.filter((c) => !term || (c.q + ' ' + c.r).toLowerCase().includes(term));
}

// slide : 'from-right' (carte suivante), 'from-left' (carte précédente) ou rien.
function openEditor(ch, card, slide) {
  state.edit = {
    chId: ch.id,
    cardId: card ? card.id : null,
    img_q: card ? card.img_q || null : null,
    img_r: card ? card.img_r || null : null,
    orig: { q: card ? card.q : '', r: card ? card.r : '', img_q: card ? card.img_q || null : null, img_r: card ? card.img_r || null : null },
    uploads: {}, // côté ('q' ou 'r') -> { path, base64 }
    busy: false,
  };
  state.discardUntil = 0;
  setEditorBusy(false);
  $('fQ').value = card ? card.q : '';
  $('fR').value = card ? card.r : '';
  $('fDelete').hidden = !card;
  $('deleteConfirm').hidden = true;
  setStatus('fStatus', ch.matiereNom + ' · ' + ch.nom);
  renderImgPreview('q');
  renderImgPreview('r');
  updateEditorNav();
  const body = $('editBody');
  body.classList.remove('from-right', 'from-left');
  if (slide) { void body.offsetWidth; body.classList.add(slide); }
  if ($('view-carte').hidden) showView('carte');
  // Aperçu immédiat (sans attendre la temporisation de saisie).
  clearTimeout(previewTimer);
  renderFace($('pQ'), $('fQ').value, state.edit.img_q);
  renderFace($('pR'), $('fR').value, state.edit.img_r);
}

function updateEditorNav() {
  const ed = state.edit;
  const ch = state.byId.get(ed.chId);
  const list = visibleCards(ch);
  const i = ed.cardId ? list.findIndex((c) => c.id === ed.cardId) : -1;
  $('editTitle').textContent = i >= 0 ? 'Carte ' + (i + 1) + ' / ' + list.length : (ed.cardId ? 'Modifier la carte' : 'Nouvelle carte');
  $('editPrev').disabled = ed.busy || i <= 0;
  $('editNext').disabled = ed.busy || i < 0 || i >= list.length - 1;
  $('swipeHint').hidden = i < 0 || list.length < 2;
}

function isEditorDirty() {
  const ed = state.edit;
  if (!ed) return false;
  return $('fQ').value !== ed.orig.q || $('fR').value !== ed.orig.r ||
    ed.img_q !== ed.orig.img_q || ed.img_r !== ed.orig.img_r;
}

// Passe à la carte voisine (dir = +1 suivante, -1 précédente).
function goToCard(dir) {
  const ed = state.edit;
  if (!ed || ed.busy || !ed.cardId) return;
  const ch = state.byId.get(ed.chId);
  const list = visibleCards(ch);
  const i = list.findIndex((c) => c.id === ed.cardId);
  const target = list[i + dir];
  if (i < 0 || !target) return;
  if (isEditorDirty() && Date.now() > state.discardUntil) {
    state.discardUntil = Date.now() + 4000;
    toast('Modifications non enregistrées. Enregistre-les, ou recommence pour les abandonner.');
    return;
  }
  openEditor(ch, target, dir > 0 ? 'from-right' : 'from-left');
}

function bindSwipe() {
  const view = $('view-carte');
  let start = null;
  view.addEventListener('touchstart', (e) => {
    // Pas de défilement depuis un champ de saisie (sélection de texte, curseur).
    if (e.touches.length !== 1 || e.target.closest('textarea, input, select, mjx-container[display="true"]')) { start = null; return; }
    start = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  }, { passive: true });
  view.addEventListener('touchend', (e) => {
    if (!start) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    const fast = Date.now() - start.t < 600;
    start = null;
    if (fast && Math.abs(dx) > 60 && Math.abs(dx) > 1.8 * Math.abs(dy)) goToCard(dx < 0 ? 1 : -1);
  }, { passive: true });
}
function renderImgPreview(side) {
  const path = state.edit['img_' + side];
  const prev = $(side === 'q' ? 'fImgQPrev' : 'fImgRPrev');
  prev.innerHTML = '';
  if (path) {
    const im = new Image();
    im.alt = '';
    im.src = imageUrl(path);
    prev.appendChild(im);
  }
  $(side === 'q' ? 'fImgQDel' : 'fImgRDel').hidden = !path;
}
let previewTimer;
function updatePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    if (!state.edit) return;
    renderFace($('pQ'), $('fQ').value, state.edit.img_q);
    renderFace($('pR'), $('fR').value, state.edit.img_r);
  }, 250);
}
function resizeImage(file, max = 1200) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible.')); };
    img.src = url;
  });
}
async function pickImage(side, input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file || !state.edit) return;
  try {
    const dataUrl = await resizeImage(file);
    const path = 'images/' + newId() + '.jpg';
    state.imgCache.set(path, dataUrl);
    state.edit.uploads[side] = { path, base64: dataUrl.split(',')[1] };
    state.edit['img_' + side] = path;
    renderImgPreview(side);
    updatePreview();
  } catch (e) {
    setStatus('fStatus', e.message, 'error');
  }
}
function removeImage(side) {
  if (!state.edit) return;
  state.edit['img_' + side] = null;
  delete state.edit.uploads[side];
  renderImgPreview(side);
  updatePreview();
}

// Modifie le fichier JSON d'un chapitre sur GitHub, en relisant le fichier en cas de conflit.
async function updateChapterFile(ch, mutate, message, retry = true) {
  const { gh, config } = state;
  if (!ch.sha) {
    const f = await gh.getFile(config.contentRepo, 'decks/' + ch.file);
    if (f) { const d = JSON.parse(f.text); ch.cartes = d.cartes || []; ch.sha = f.sha; }
  }
  const cartes = mutate(ch.cartes.map((c) => ({ ...c })));
  const data = { id: ch.id, nom: ch.nom, cartes };
  try {
    ch.sha = await gh.putFile(config.contentRepo, 'decks/' + ch.file, JSON.stringify(data, null, 2) + '\n', ch.sha, message);
    ch.cartes = cartes;
  } catch (e) {
    if (retry && isConflict(e)) {
      ch.sha = null; // relecture puis nouvelle tentative
      return updateChapterFile(ch, mutate, message, false);
    }
    throw e;
  }
}
function setEditorBusy(busy) {
  if (state.edit) state.edit.busy = busy;
  ['fSave', 'fDelete', 'fDeleteYes', 'editBack'].forEach((id) => { $(id).disabled = busy; });
  if (busy) { $('editPrev').disabled = true; $('editNext').disabled = true; }
}
async function saveCard() {
  const ed = state.edit;
  if (!ed || ed.busy) return;
  const ch = state.byId.get(ed.chId);
  const q = $('fQ').value.trim(), r = $('fR').value.trim();
  if (!q || !r) { setStatus('fStatus', 'La question et la réponse sont obligatoires.', 'error'); return; }
  if (!canEdit()) { setStatus('fStatus', 'Renseigne ton jeton GitHub dans les réglages pour enregistrer.', 'error'); return; }
  setEditorBusy(true);
  setStatus('fStatus', 'Enregistrement sur GitHub…');
  try {
    for (const side of ['q', 'r']) {
      const up = ed.uploads[side];
      if (up && ed['img_' + side] === up.path) {
        await state.gh.putFile(state.config.contentRepo, up.path, up.base64, null, 'Ajoute une image de carte (' + ch.nom + ')', true);
      }
      delete ed.uploads[side];
    }
    const card = { id: ed.cardId || newId(), q, r };
    if (ed.img_q) card.img_q = ed.img_q;
    if (ed.img_r) card.img_r = ed.img_r;
    const isNew = !ed.cardId;
    await updateChapterFile(ch, (list) => {
      const i = list.findIndex((c) => c.id === card.id);
      if (i >= 0) list[i] = card; else list.push(card);
      return list;
    }, (isNew ? 'Ajoute' : 'Modifie') + ' une carte : ' + ch.nom);
    toast(isNew ? 'Carte ajoutée.' : 'Carte enregistrée.');
    // On reste sur la carte enregistrée pour pouvoir continuer à défiler.
    openEditor(ch, ch.cartes.find((c) => c.id === card.id) || card);
  } catch (e) {
    setStatus('fStatus', 'Échec de l\'enregistrement : ' + e.message, 'error');
    setEditorBusy(false);
  }
}
async function deleteCard() {
  const ed = state.edit;
  if (!ed || ed.busy || !ed.cardId) return;
  const ch = state.byId.get(ed.chId);
  setEditorBusy(true);
  setStatus('fStatus', 'Suppression…');
  const before = visibleCards(ch);
  const pos = before.findIndex((c) => c.id === ed.cardId);
  try {
    await updateChapterFile(ch, (list) => list.filter((c) => c.id !== ed.cardId), 'Supprime une carte : ' + ch.nom);
    toast('Carte supprimée.');
    // Affiche la carte suivante (ou la précédente s'il s'agissait de la dernière).
    const after = visibleCards(ch);
    const next = after[Math.min(Math.max(pos, 0), after.length - 1)];
    if (next) openEditor(ch, next, 'from-right');
    else { state.edit = null; location.hash === '#cartes' ? route() : (location.hash = 'cartes'); }
  } catch (e) {
    setStatus('fStatus', 'Échec de la suppression : ' + e.message, 'error');
    setEditorBusy(false);
  }
}
function slugify(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}
async function createChapter() {
  const mat = $('ncMatiere').value;
  const nom = $('ncNom').value.trim();
  const slug = slugify(nom);
  if (!nom || !slug) { toast('Donne un nom au chapitre.'); return; }
  const id = mat + '-' + slug;
  if (state.byId.has(id)) { toast('Ce chapitre existe déjà.'); return; }
  const file = mat + '/' + slug + '.json';
  const { gh, config } = state;
  $('ncCreate').disabled = true;
  try {
    const sha = await gh.putFile(config.contentRepo, 'decks/' + file,
      JSON.stringify({ id, nom, cartes: [] }, null, 2) + '\n', null, 'Ajoute le chapitre ' + nom);
    // Ajout du chapitre dans index.json (relu juste avant pour ne rien écraser).
    for (let attempt = 0; attempt < 2; attempt++) {
      const f = await gh.getFile(config.contentRepo, 'decks/index.json');
      const index = JSON.parse(f.text);
      const m = index.matieres.find((x) => x.id === mat);
      if (!m.chapitres.includes(file)) m.chapitres.push(file);
      try {
        await gh.putFile(config.contentRepo, 'decks/index.json', JSON.stringify(index, null, 2) + '\n', f.sha, 'Ajoute le chapitre ' + nom + ' à l\'index');
        break;
      } catch (e) { if (!isConflict(e) || attempt === 1) throw e; }
    }
    const m = state.matieres.find((x) => x.id === mat);
    const ch = { id, nom, cartes: [], matiere: mat, matiereNom: m.nom, file, sha };
    m.chapitres.push(ch);
    state.chapters = state.matieres.flatMap((x) => x.chapitres);
    state.byId.set(id, ch);
    state.editChapterId = id;
    $('ncNom').value = '';
    $('newChapterForm').hidden = true;
    toast('Chapitre créé.');
    renderCartes();
  } catch (e) {
    toast('Échec de la création : ' + e.message);
  } finally {
    $('ncCreate').disabled = false;
  }
}

// =====================================================================
// Statistiques
// =====================================================================
function lastDays(n) {
  const days = [];
  for (let i = n - 1; i >= 0; i--) days.push(S.inDays(-i));
  return days;
}
function streak() {
  const p = state.progress;
  let i = S.dayTotals(p, S.today()).r > 0 ? 0 : 1;
  let n = 0;
  while (S.dayTotals(p, S.inDays(-i)).r > 0) { n++; i++; }
  return n;
}
function shortDate(isoDay) {
  const [, m, d] = isoDay.split('-');
  return d + '/' + m;
}
function renderStats() {
  const p = state.progress;
  const days = lastDays(30);
  const totals = days.map((d) => S.dayTotals(p, d));
  const r30 = totals.reduce((s, t) => s + t.r, 0);
  const c30 = totals.reduce((s, t) => s + t.c, 0);
  let mastered = 0, all = 0;
  state.chapters.forEach((ch) => ch.cartes.forEach((card) => {
    all++;
    const st = S.cardState(p, ch, card);
    if (st && st.box === 5) mastered++;
  }));
  const tiles = [
    [streak(), 'jours de suite'],
    [totals[totals.length - 1].r, 'réponses aujourd\'hui'],
    [r30 ? Math.round(c30 / r30 * 100) + ' %' : '–', 'de réussite sur 30 jours'],
    [mastered + ' / ' + all, 'cartes au palier ' + boxLabel(5)],
  ];
  $('statTiles').innerHTML = tiles.map(([v, l]) => '<div class="tile"><div class="v">' + v + '</div><div class="l">' + l + '</div></div>').join('');

  // Réponses par jour : barres empilées justes (bas) / ratées (haut).
  const W = 360, H = 170, L = 26, B = 22, T = 10;
  const max = Math.max(4, ...totals.map((t) => t.r));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const y = (v) => H - B - (v / top) * (H - B - T);
  const bw = (W - L) / days.length;
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Réponses par jour sur 30 jours">';
  for (let v = 0; v <= top; v += step) {
    svg += '<line class="grid" x1="' + L + '" x2="' + W + '" y1="' + y(v) + '" y2="' + y(v) + '"/>' +
      '<text x="' + (L - 6) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + v + '</text>';
  }
  totals.forEach((t, i) => {
    const x = L + i * bw + 2, w = Math.max(2, bw - 4);
    const tip = '<title>' + shortDate(days[i]) + ' : ' + t.c + ' justes, ' + (t.r - t.c) + ' ratées</title>';
    if (t.c) svg += '<rect class="c-good" x="' + x + '" y="' + y(t.c) + '" width="' + w + '" height="' + (y(0) - y(t.c)) + '" rx="2">' + tip + '</rect>';
    if (t.r - t.c) svg += '<rect class="c-bad" x="' + x + '" y="' + y(t.r) + '" width="' + w + '" height="' + Math.max(0, y(t.c) - y(t.r) - 2) + '" rx="2">' + tip + '</rect>';
    if (i === days.length - 1) svg += '<text x="' + (x + w) + '" y="' + (H - 6) + '" text-anchor="end">' + shortDate(days[i]) + '</text>';
    else if (i % 7 === 1) svg += '<text x="' + (x + w / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + shortDate(days[i]) + '</text>';
  });
  svg += '</svg><div class="chart-legend"><span><i class="c-good" style="background:var(--good)"></i>Justes</span><span><i style="background:var(--again);opacity:.55"></i>Ratées</span></div>';
  $('chart30').innerHTML = svg;

  // Par matière : réussite sur 30 jours et répartition dans les boîtes.
  const legend = ['Jamais vues', 1, 2, 3, 4, 5].map((b) => typeof b === 'number' ? boxLabel(b) : b);
  const shade = (i) => i === 0 ? 'var(--line)' : 'color-mix(in srgb, var(--accent) ' + (20 + i * 16) + '%, transparent)';
  let html = '';
  state.matieres.forEach((m) => {
    if (!m.chapitres.length) return;
    let r = 0, c = 0;
    totals.forEach((t) => { if (t.m[m.id]) { r += t.m[m.id][0]; c += t.m[m.id][1]; } });
    const counts = [0, 0, 0, 0, 0, 0];
    m.chapitres.forEach((ch) => chapterCounts(ch).forEach((n, i) => { counts[i] += n; }));
    const n = counts.reduce((a, b) => a + b, 0) || 1;
    html += '<div class="mat-stat"><div class="head"><h3>' + escapeHtml(m.nom) + '</h3><span>' +
      (r ? Math.round(c / r * 100) + ' % de réussite · ' + plural(r, 'réponse', 'réponses') : 'pas de révision sur 30 jours') +
      '</span></div><div class="stack" title="' + counts.map((v, i) => legend[i] + ' : ' + v).join(', ') + '">' +
      counts.map((v, i) => v ? '<div style="width:' + (v / n * 100) + '%;background:' + shade(i) + '"></div>' : '').join('') + '</div></div>';
  });
  html += '<div class="chart"><div class="chart-legend">' + legend.map((l, i) => '<span><i style="background:' + shade(i) + '"></i>' + l + '</span>').join('') + '</div></div>';
  $('statMatieres').innerHTML = html;

  // Prévision : cartes déjà vues qui reviennent chaque jour (le retard est compté aujourd'hui).
  const next = lastDays(1).concat([1, 2, 3, 4, 5, 6].map((i) => S.inDays(i)));
  const fc = next.map(() => 0);
  activeChapters().forEach((ch) => ch.cartes.forEach((card) => {
    const st = S.cardState(p, ch, card);
    if (!st) return;
    const i = st.due <= next[0] ? 0 : next.indexOf(st.due);
    if (i >= 0) fc[i]++;
  }));
  const fmax = Math.max(4, ...fc);
  const fH = 130, fB = 34;
  const fy = (v) => fH - fB - (v / fmax) * (fH - fB - 16);
  const fw = W / 7;
  let f = '<svg viewBox="0 0 ' + W + ' ' + fH + '" role="img" aria-label="Cartes prévues sur 7 jours">';
  fc.forEach((v, i) => {
    const x = i * fw + 5, w = fw - 10;
    const label = i === 0 ? 'auj.' : new Date(next[i] + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'short' });
    if (v) f += '<rect class="c-acc" x="' + x + '" y="' + fy(v) + '" width="' + w + '" height="' + (fy(0) - fy(v)) + '" rx="3"><title>' + shortDate(next[i]) + ' : ' + v + '</title></rect>';
    f += '<text x="' + (x + w / 2) + '" y="' + (fy(v) - 4) + '" text-anchor="middle">' + v + '</text>' +
      '<text x="' + (x + w / 2) + '" y="' + (fH - 18) + '" text-anchor="middle">' + label + '</text>' +
      '<text x="' + (x + w / 2) + '" y="' + (fH - 5) + '" text-anchor="middle">' + shortDate(next[i]) + '</text>';
  });
  f += '<line class="grid" x1="0" x2="' + W + '" y1="' + fy(0) + '" y2="' + fy(0) + '"/></svg>';
  const newTotal = state.matieres.reduce((sum, m) => sum + S.subjectLimits(p.settings, m.id).newPerDay, 0);
  $('forecast').innerHTML = f + '<p class="sub">Hors nouvelles cartes : jusqu\'à ' + newTotal + ' par jour selon tes réglages par matière.</p>';
}

// =====================================================================
// Réglages
// =====================================================================
function renderSettings() {
  const s = state.progress.settings;
  renderSubjectLimits();
  const off = new Set(s.inactive || []);
  buildChecklist($('activeChapters'), (ch) => !off.has(ch.id), (chs, on) => {
    const set = new Set(state.progress.settings.inactive || []);
    chs.forEach((ch) => (on ? set.delete(ch.id) : set.add(ch.id)));
    updateSettings({ inactive: [...set] });
  });
  $('gToken').value = state.config.token ? state.config.token : '';
  $('gContent').value = state.config.contentRepo || guessContentRepo();
  $('gData').value = state.config.dataRepo || ($('gContent').value ? $('gContent').value + '-data' : '');
  const last = state.config.lastSync ? new Date(state.config.lastSync).toLocaleString('fr-FR') : null;
  if (!$('gStatus').textContent) setStatus('gStatus', canSync() ? 'Dernière synchronisation : ' + (last || 'jamais') : 'Synchronisation non configurée.');
}
// Tableau des limites quotidiennes : une ligne par matière, nouvelles cartes et révisions maximum.
function renderSubjectLimits() {
  const box = $('subjectLimits');
  box.innerHTML = '<span></span><span class="lh">Nouvelles</span><span class="lh">Révisions</span>';
  state.matieres.forEach((m) => {
    const lim = S.subjectLimits(state.progress.settings, m.id);
    const name = document.createElement('span');
    name.className = 'ln';
    name.textContent = m.nom;
    box.appendChild(name);
    [['newPerDay', 500, 'nouvelles cartes par jour'], ['maxReviews', 2000, 'révisions maximum par jour']].forEach(([field, max, label]) => {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = String(max);
      input.inputMode = 'numeric';
      input.id = 'lim-' + m.id + '-' + field;
      input.value = lim[field];
      input.setAttribute('aria-label', m.nom + ' : ' + label);
      input.addEventListener('change', () => {
        const current = S.subjectLimits(state.progress.settings, m.id);
        const v = readNumber(input.id, 0, max, current[field]);
        input.value = v;
        const subjects = { ...(state.progress.settings.subjects || {}) };
        subjects[m.id] = { ...current, [field]: v };
        updateSettings({ subjects });
        updateLimitsTotal();
      });
      box.appendChild(input);
    });
  });
  updateLimitsTotal();
}
function updateLimitsTotal() {
  const s = state.progress.settings;
  let nw = 0, rv = 0, unlimited = false;
  state.matieres.forEach((m) => {
    const lim = S.subjectLimits(s, m.id);
    nw += lim.newPerDay;
    if (lim.maxReviews === 0) unlimited = true; else rv += lim.maxReviews;
  });
  $('limitsTotal').textContent = 'Total par jour : ' + plural(nw, 'nouvelle carte', 'nouvelles cartes') + ' et ' +
    (unlimited ? 'des révisions sans limite pour au moins une matière.' : 'au plus ' + plural(rv, 'révision', 'révisions') + '.');
}
// Sur GitHub Pages, l'adresse pseudo.github.io/depot donne le dépôt du site.
function guessContentRepo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return m && repo ? m[1] + '/' + repo : '';
}
function updateSettings(patch) {
  state.progress.settings = { ...state.progress.settings, ...patch, updated: Date.now() };
  saveProgress();
  setStatus('sStatus', 'Réglages enregistrés.', 'ok');
  scheduleSync(2000);
}
function readNumber(id, min, max, fallback) {
  const v = Math.round(Number($(id).value));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}
async function saveGitHubConfig() {
  const token = $('gToken').value.trim();
  const contentRepo = $('gContent').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
  const dataRepo = $('gData').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(contentRepo) || !/^[\w.-]+\/[\w.-]+$/.test(dataRepo)) {
    setStatus('gStatus', 'Renseigne le jeton et les deux dépôts sous la forme pseudo/depot.', 'error');
    return;
  }
  $('gSave').disabled = true;
  setStatus('gStatus', 'Vérification de l\'accès…');
  const gh = new GitHub(token);
  try {
    const site = await gh.checkRepo(contentRepo);
    const data = await gh.checkRepo(dataRepo);
    const problems = [];
    if (!site.canWrite) problems.push('le jeton ne peut pas écrire dans ' + contentRepo + ' (l\'éditeur de cartes ne marchera pas)');
    if (!data.canWrite) problems.push('le jeton ne peut pas écrire dans ' + dataRepo);
    if (!data.private) problems.push(dataRepo + ' est public : ta progression sera visible de tous');
    state.config = { ...state.config, token, contentRepo, dataRepo };
    S.saveConfig(state.config);
    state.gh = gh;
    setStatus('gStatus', problems.length ? 'Enregistré, mais ' + problems.join(' ; ') + '.' : 'Accès vérifié. Synchronisation…', problems.length ? 'error' : 'ok');
    await loadDecks().catch(() => {});
    await syncNow();
    if (!problems.length) setStatus('gStatus', 'Synchronisé avec ' + dataRepo + '.', 'ok');
  } catch (e) {
    const msg = e.status === 401 ? 'Jeton refusé par GitHub (invalide ou expiré).'
      : e.status === 404 ? 'Dépôt introuvable, ou le jeton n\'y a pas accès.'
      : e.message;
    setStatus('gStatus', msg, 'error');
  } finally {
    $('gSave').disabled = false;
  }
}
function forgetToken() {
  state.config = { ...state.config, token: '' };
  S.saveConfig(state.config);
  state.gh = null;
  $('gToken').value = '';
  setChip('local');
  setStatus('gStatus', 'Jeton supprimé de cet appareil. La progression reste enregistrée localement.');
}
function exportProgress() {
  const blob = new Blob([JSON.stringify(state.progress, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'flashcards-progression-' + S.today() + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  setStatus('xStatus', 'Fichier exporté.', 'ok');
}
async function importProgress(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data.cards !== 'object') throw new Error();
    state.progress = S.merge(state.progress, data);
    saveProgress();
    setStatus('xStatus', 'Progression importée et fusionnée avec celle de cet appareil.', 'ok');
    scheduleSync(0);
  } catch (e) {
    setStatus('xStatus', 'Ce fichier n\'est pas une sauvegarde de progression valide.', 'error');
  }
}

// =====================================================================
// Synchronisation avec le dépôt privé
// =====================================================================
function setChip(kind, detail) {
  const chip = $('syncChip');
  const text = { local: 'Local', busy: 'Synchro…', ok: 'Synchronisé', error: 'Erreur synchro' }[kind];
  chip.textContent = text;
  chip.className = 'chip' + (kind === 'local' ? '' : ' ' + kind);
  chip.title = detail || (kind === 'local' ? 'Progression enregistrée seulement sur cet appareil' : 'Synchroniser maintenant');
}
let syncTimer = null;
function scheduleSync(delay = 1500) {
  if (!canSync()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; syncNow(); }, delay);
}
async function syncNow(retry = true) {
  if (!canSync()) { setChip('local'); return; }
  if (state.syncing) { state.syncAgain = true; return; }
  state.syncing = true;
  setChip('busy');
  const { gh, config } = state;
  try {
    const remote = await gh.getFile(config.dataRepo, 'progress.json');
    const remoteP = remote ? S.normalize(JSON.parse(remote.text)) : null;
    const merged = remoteP ? S.merge(state.progress, remoteP) : S.normalize(state.progress);
    state.progress = merged;
    saveProgress();
    if (!remoteP || S.stableStringify(merged) !== S.stableStringify(remoteP)) {
      await gh.putFile(config.dataRepo, 'progress.json', JSON.stringify(merged), remote && remote.sha,
        'Sauvegarde de la progression (' + S.deviceId() + ')');
    }
    state.config.lastSync = Date.now();
    S.saveConfig(state.config);
    setChip('ok', 'Dernière synchronisation : ' + new Date().toLocaleTimeString('fr-FR'));
    refreshIfIdle();
  } catch (e) {
    if (retry && isConflict(e)) {
      state.syncing = false;
      await syncNow(false); // l'autre appareil vient d'écrire : on relit et on fusionne
      return;
    }
    setChip('error', e.message);
    console.warn('Synchronisation impossible', e);
  } finally {
    state.syncing = false;
    if (state.syncAgain) { state.syncAgain = false; scheduleSync(500); }
  }
}

// =====================================================================
// Événements
// =====================================================================
function bindEvents() {
  window.addEventListener('hashchange', route);
  document.addEventListener('mathjax-ready', () => {
    typeset(...['question', 'answer', 'pQ', 'pR', 'cardList'].map($).filter((el) => el && el.offsetParent !== null));
  });

  $('syncChip').addEventListener('click', () => {
    if (canSync()) syncNow();
    else if (!state.session) location.hash = 'parametres';
  });

  $('startDaily').addEventListener('click', () => startSession(S.dailyQueue(state.progress, activeChapters()).items, 'srs', 'Révision du jour'));
  $('show').addEventListener('click', reveal);
  $('good').addEventListener('click', () => grade(true));
  $('again').addEventListener('click', () => grade(false));
  $('quit').addEventListener('click', leaveSession);
  $('back').addEventListener('click', leaveSession);
  $('undo').addEventListener('click', undoLast);
  $('doneUndo').addEventListener('click', undoLast);
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'Backspace' && (state.session || (state.finished && !$('view-done').hidden))) {
      e.preventDefault();
      undoLast();
      return;
    }
    if (!state.session) return;
    if (e.key === ' ' || e.key === 'Enter') {
      if ($('answer').hidden) { e.preventDefault(); reveal(); }
    } else if (e.key === 'ArrowRight') grade(true);
    else if (e.key === 'ArrowLeft') grade(false);
    else if (e.key === 'Escape') leaveSession();
  });

  $('cramCount').addEventListener('change', updateCramInfo);
  $('cramHard').addEventListener('change', updateCramInfo);
  $('startCram').addEventListener('click', startCram);

  $('editChapter').addEventListener('change', (e) => { state.editChapterId = e.target.value; $('cardSearch').value = ''; renderCardList(); });
  $('cardSearch').addEventListener('input', renderCardList);
  $('newCard').addEventListener('click', () => { const ch = state.byId.get(state.editChapterId); if (ch) openEditor(ch, null); });
  $('newChapter').addEventListener('click', () => { $('newChapterForm').hidden = false; $('ncNom').focus(); });
  $('ncCancel').addEventListener('click', () => { $('newChapterForm').hidden = true; });
  $('ncCreate').addEventListener('click', createChapter);
  $('editBack').addEventListener('click', () => {
    if (isEditorDirty() && Date.now() > state.discardUntil) {
      state.discardUntil = Date.now() + 4000;
      toast('Modifications non enregistrées. Appuie à nouveau sur Retour pour les abandonner.');
      return;
    }
    state.edit = null;
    route();
  });
  $('editPrev').addEventListener('click', () => goToCard(-1));
  $('editNext').addEventListener('click', () => goToCard(1));
  bindSwipe();
  document.addEventListener('keydown', (e) => {
    if ($('view-carte').hidden || e.target.matches('input, textarea, select')) return;
    if (e.key === 'ArrowRight') goToCard(1);
    else if (e.key === 'ArrowLeft') goToCard(-1);
  });
  $('fQ').addEventListener('input', updatePreview);
  $('fR').addEventListener('input', updatePreview);
  $('fImgQ').addEventListener('change', (e) => pickImage('q', e.target));
  $('fImgR').addEventListener('change', (e) => pickImage('r', e.target));
  $('fImgQDel').addEventListener('click', () => removeImage('q'));
  $('fImgRDel').addEventListener('click', () => removeImage('r'));
  $('fSave').addEventListener('click', saveCard);
  $('fDelete').addEventListener('click', () => { $('deleteConfirm').hidden = false; });
  $('fDeleteNo').addEventListener('click', () => { $('deleteConfirm').hidden = true; });
  $('fDeleteYes').addEventListener('click', deleteCard);

  $('gSave').addEventListener('click', saveGitHubConfig);
  $('gForget').addEventListener('click', forgetToken);
  $('exportBtn').addEventListener('click', exportProgress);
  $('importFile').addEventListener('change', (e) => importProgress(e.target));

  // Sauvegarde quand on quitte l'appli, récupération des changements de l'autre appareil au retour.
  document.addEventListener('visibilitychange', () => {
    if (!canSync()) return;
    if (document.visibilityState === 'hidden') {
      if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; syncNow(); }
    } else if (Date.now() - (state.config.lastSync || 0) > 60000) {
      scheduleSync(0);
    }
  });
}

async function init() {
  bindEvents();
  if (state.config.token) state.gh = new GitHub(state.config.token);
  setChip(canSync() ? 'busy' : 'local');
  try {
    await loadDecks();
  } catch (e) {
    $('chapterList').innerHTML = '<p class="status error">Impossible de charger les cartes. Vérifie le dossier « decks » et le fichier index.json.</p>';
  }
  route();
  if (canSync()) syncNow();
}

init();
