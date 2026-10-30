// Onglet Bachotage : révision libre (cartes ou QCM) et jeu d'associations, sans effet sur la progression.
import * as S from './store.js?v=20261030233452';
import {
  $, state, textHtml, typeset, toast, plural, showView, goTab, faceContent, expectedAnswer,
} from './ui.js?v=20261030233452';
import { startSession, leaveSession } from './review.js?v=20261030233452';

// =====================================================================
// Listes de chapitres à cocher (bachotage et réglages)
// =====================================================================
export function buildChecklist(container, isChecked, onChange) {
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
function isHard(st) {
  return !st || st.state !== 'review' || st.ivl <= 3 || (st.l || 0) >= 2;
}
function cramPool() {
  const hard = $('cramHard').checked;
  const assoc = $('cramMode').value === 'assoc';
  const pool = [];
  state.chapters.forEach((ch) => {
    if (!state.cramSel.has(ch.id)) return;
    S.faces(ch).forEach((f) => {
      if (assoc && (f.rev || f.card.mode === 'trou')) return; // associations : sens question → réponse, sans textes à trous
      if (hard && !isHard(S.stateOf(state.progress, f.key))) return;
      pool.push({ ...f, kind: 'cram' });
    });
  });
  return pool;
}
// Nombre de cartes : raccourci choisi (0 = toutes) ou nombre tapé dans le champ.
let cramPreset = 20;
function cramMax() {
  const typed = parseInt($('cramCountInput').value, 10);
  return Number.isFinite(typed) && typed > 0 ? typed : cramPreset;
}
function paintCount() {
  const typed = $('cramCountInput').value.trim() !== '';
  $('cramCount').querySelectorAll('button').forEach((b) => {
    const on = !typed && Number(b.dataset.n) === cramPreset;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}
function updateCramInfo() {
  const n = cramPool().length;
  const max = cramMax() || n;
  const assoc = $('cramMode').value === 'assoc';
  $('cramInfo').textContent = n
    ? plural(n, 'carte disponible', 'cartes disponibles') + ', ' + Math.min(n, max) + ' au programme' + (assoc ? ', par manches de 5 paires.' : '.')
    : 'Coche au moins un chapitre.';
  $('startCram').disabled = assoc ? n < 2 : n === 0;
}
export function renderCram() {
  buildChecklist($('cramChapters'), (ch) => state.cramSel.has(ch.id), (chs, on) => {
    chs.forEach((ch) => (on ? state.cramSel.add(ch.id) : state.cramSel.delete(ch.id)));
    updateCramInfo();
  });
  updateCramInfo();
}

// mode : 'cram' (cartes), 'qcm' ou 'assoc'.
export function startPractice(items, mode, max = 0) {
  let pool = S.shuffle(items.slice());
  if (max) pool = pool.slice(0, max);
  if (mode === 'assoc') return startAssoc(pool);
  startSession(pool, mode, 'Bachotage');
}

// Manche d'associations au milieu d'un bachotage « Tout mélangé » ; onDone(erreurs) reprend la session.
export function startMixRound(items, onDone) {
  state.assoc = { rounds: [items], round: 0, errors: 0, start: Date.now(), selected: null, found: 0, items, mix: onDone };
  showView('assoc');
  renderRound();
}

// =====================================================================
// Associations
// =====================================================================
const PAIRS_PER_ROUND = 5;

function startAssoc(items) {
  // Une seule face par carte, et des réponses toutes différentes dans une même manche.
  const seen = new Set();
  const usable = items.filter((it) => {
    const k = it.chapter.id + '/' + it.card.id;
    if (seen.has(k) || !expectedAnswer(it.card)) return false;
    seen.add(k);
    return true;
  });
  const rounds = [];
  let cur = [];
  usable.forEach((it) => {
    if (cur.some((x) => expectedAnswer(x.card) === expectedAnswer(it.card))) return;
    cur.push(it);
    if (cur.length === PAIRS_PER_ROUND) { rounds.push(cur); cur = []; }
  });
  if (cur.length >= 2) rounds.push(cur);
  else if (cur.length && rounds.length) rounds[rounds.length - 1].push(...cur);
  if (!rounds.length) { toast('Il faut au moins deux cartes différentes pour jouer aux associations.'); return; }
  state.assoc = { rounds, round: 0, errors: 0, start: Date.now(), selected: null, found: 0, items: items };
  state.lastMode = 'cram';
  showView('assoc');
  renderRound();
}

function tile(text, key, side) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tile-btn';
  b.dataset.key = key;
  b.dataset.side = side;
  b.innerHTML = textHtml(text);
  b.addEventListener('click', () => pick(b));
  return b;
}

function renderRound() {
  const a = state.assoc;
  const items = a.rounds[a.round];
  a.selected = null;
  a.found = 0;
  const left = $('assocLeft'), right = $('assocRight');
  left.innerHTML = '';
  right.innerHTML = '';
  S.shuffle(items.slice()).forEach((it) => left.appendChild(tile(faceContent(it).q, it.key, 'q')));
  S.shuffle(items.slice()).forEach((it) => right.appendChild(tile(expectedAnswer(it.card).split(' / ')[0], it.key, 'r')));
  $('assocCounter').textContent = a.mix ? 'Pause associations' : 'Manche ' + (a.round + 1) + ' / ' + a.rounds.length;
  $('assocStatus').textContent = 'Touche une question puis la réponse qui va avec.';
  $('assocNext').hidden = true;
  $('assocNext').textContent = a.mix ? 'Continuer' : 'Manche suivante';
  $('assocDone').hidden = true;
  $('assocBoard').hidden = false;
  typeset(left, right);
}

function pick(btn) {
  const a = state.assoc;
  if (!a || btn.classList.contains('matched')) return;
  const prev = a.selected;
  if (!prev || prev.dataset.side === btn.dataset.side) {
    if (prev) prev.classList.remove('selected');
    a.selected = prev === btn ? null : btn;
    if (a.selected) btn.classList.add('selected');
    return;
  }
  prev.classList.remove('selected');
  a.selected = null;
  if (prev.dataset.key === btn.dataset.key) {
    [prev, btn].forEach((b) => { b.classList.add('matched'); b.disabled = true; });
    a.found++;
    if (a.found === a.rounds[a.round].length) roundDone();
  } else {
    a.errors++;
    [prev, btn].forEach((b) => {
      b.classList.add('wrong');
      setTimeout(() => b.classList.remove('wrong'), 600);
    });
  }
}

function roundDone() {
  const a = state.assoc;
  if (a.mix || a.round < a.rounds.length - 1) {
    $('assocStatus').textContent = 'Manche réussie.';
    $('assocNext').hidden = false;
    $('assocNext').focus({ preventScroll: true });
    return;
  }
  const pairs = a.rounds.reduce((s, r) => s + r.length, 0);
  const sec = Math.round((Date.now() - a.start) / 1000);
  const time = sec >= 60 ? Math.floor(sec / 60) + ' min ' + String(sec % 60).padStart(2, '0') + ' s' : sec + ' s';
  $('assocBoard').hidden = true;
  $('assocDone').hidden = false;
  $('assocDoneText').textContent = plural(pairs, 'paire trouvée', 'paires trouvées') + ' en ' + time + ', ' + plural(a.errors, 'erreur', 'erreurs') + '.';
  $('assocStatus').textContent = '';
}

function quitAssoc() {
  const mix = state.assoc && state.assoc.mix;
  state.assoc = null;
  if (mix) leaveSession();
  else goTab('bachotage');
}

export function bindPractice() {
  $('cramCount').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    cramPreset = Number(b.dataset.n);
    $('cramCountInput').value = '';
    paintCount();
    updateCramInfo();
  }));
  $('cramCountInput').addEventListener('input', () => { paintCount(); updateCramInfo(); });
  paintCount();
  $('cramHard').addEventListener('change', updateCramInfo);
  $('cramMode').addEventListener('change', updateCramInfo);
  $('startCram').addEventListener('click', () => {
    startPractice(cramPool(), $('cramMode').value, cramMax());
  });
  $('assocNext').addEventListener('click', () => {
    const a = state.assoc;
    if (a && a.mix) { state.assoc = null; a.mix(a.errors); return; }
    a.round++;
    renderRound();
  });
  $('assocQuit').addEventListener('click', quitAssoc);
  $('assocEnd').addEventListener('click', quitAssoc);
  $('assocAgain').addEventListener('click', () => startAssoc(S.shuffle(state.assoc.items.slice())));
}
