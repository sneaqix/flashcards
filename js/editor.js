// Onglet Cartes : recherche dans toutes les matières, filtres et éditeur de cartes.
import * as S from './store.js?v=20261030163147';
import { retrievability } from './scheduler.js?v=20261030163147';
import {
  $, state, escapeHtml, renderFace, typeset, toast, setStatus, plural, canEdit, newId,
  showView, route, firstLine, imageUrl, faceContent,
} from './ui.js?v=20261030163147';
import { updateChapterFile, createChapterFile } from './sync.js?v=20261030163147';
import { returnToViewer } from './viewer.js?v=20261030163147';
import { resumeSession } from './review.js?v=20261030163147';
import { startPractice } from './practice.js?v=20261030163147';

const filters = { text: '', mat: '', chap: '', etat: '', type: '' };
let results = []; // [{ chapter, card }] affichés dans la liste, dans l'ordre

// =====================================================================
// Recherche et filtres
// =====================================================================
const ETATS = [
  ['', 'Tous les états'],
  ['new', 'Jamais vues'],
  ['learn', 'En cours d\'apprentissage'],
  ['due', 'À revoir aujourd\'hui'],
  ['failed', 'Ratées ces 7 derniers jours'],
  ['hard', 'Difficiles (souvent oubliées)'],
  ['young', 'Jeunes (moins de 21 jours)'],
  ['mature', 'Acquises (21 jours et plus)'],
];
const TYPES = [
  ['', 'Tous les types'],
  ['inverse', 'Inversées'],
  ['saisie', 'Réponse à taper'],
  ['qcm', 'Choix multiples'],
  ['trou', 'Texte à trous'],
  ['image', 'Avec image'],
];

function faceMatches(st, etat) {
  const day = S.today();
  switch (etat) {
    case 'new': return !st;
    case 'learn': return !!st && st.state !== 'review';
    case 'due': return !!st && (st.state !== 'review' || st.due <= day);
    case 'failed': return !!st && st.lastFail && Date.now() - st.lastFail < 7 * 86400000;
    case 'hard': return !!st && ((st.l || 0) >= 3 || (st.D || 0) >= 8.5);
    case 'young': return !!st && st.state === 'review' && st.ivl < 21;
    case 'mature': return !!st && st.state === 'review' && st.ivl >= 21;
    default: return true;
  }
}
function typeMatches(card, type) {
  switch (type) {
    case 'inverse': return !!card.inverse;
    case 'saisie': return card.mode === 'saisie';
    case 'qcm': return card.mode === 'qcm';
    case 'trou': return card.mode === 'trou';
    case 'image': return !!(card.img_q || card.img_r);
    default: return true;
  }
}
function searchText(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
export function filteredCards() {
  const term = searchText(filters.text.trim());
  const out = [];
  state.chapters.forEach((ch) => {
    if (filters.mat && ch.matiere !== filters.mat) return;
    if (filters.chap && ch.id !== filters.chap) return;
    ch.cartes.forEach((card) => {
      if (!typeMatches(card, filters.type)) return;
      if (term && !searchText([card.q, card.r, card.attendu, ch.nom].join(' ')).includes(term)) return;
      if (filters.etat) {
        const fs = S.faces(ch).filter((f) => f.card === card);
        if (!fs.some((f) => faceMatches(S.stateOf(state.progress, f.key), filters.etat))) return;
      }
      out.push({ chapter: ch, card });
    });
  });
  return out;
}

function fillSelect(sel, options, value) {
  sel.innerHTML = options.map(([v, label]) => '<option value="' + escapeHtml(v) + '">' + escapeHtml(label) + '</option>').join('');
  sel.value = options.some(([v]) => v === value) ? value : '';
}

export function renderCartes() {
  const locked = !canEdit();
  $('editorLocked').hidden = !locked;
  $('newCard').disabled = locked;
  $('newChapter').disabled = locked;
  fillSelect($('fMat'), [['', 'Toutes les matières'], ...state.matieres.map((m) => [m.id, m.nom])], filters.mat);
  filters.mat = $('fMat').value;
  const chaps = state.chapters.filter((c) => !filters.mat || c.matiere === filters.mat);
  fillSelect($('fChap'), [['', 'Tous les chapitres'], ...chaps.map((c) => [c.id, (filters.mat ? '' : c.matiereNom + ' · ') + c.nom])], filters.chap);
  filters.chap = $('fChap').value;
  fillSelect($('fEtat'), ETATS, filters.etat);
  fillSelect($('fType'), TYPES, filters.type);
  $('cardSearch').value = filters.text;
  $('ncMatiere').innerHTML = state.matieres.map((m) => '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.nom) + '</option>').join('');
  renderCardList();
}

function flagsOf(card) {
  const f = [];
  if (card.mode === 'trou') f.push('à trous');
  if (card.inverse) f.push('⇄');
  if (card.mode === 'saisie') f.push('à taper');
  if (card.mode === 'qcm') f.push('QCM');
  if (card.img_q || card.img_r) f.push('img');
  return f;
}

const MAX_SHOWN = 150;
function renderCardList() {
  results = filteredCards();
  const ul = $('cardList');
  ul.innerHTML = '';
  const n = results.length;
  const filtered = filters.text || filters.mat || filters.chap || filters.etat || filters.type;
  $('resultCount').textContent = n ? plural(n, 'carte', 'cartes') + (filtered ? ' trouvée' + (n > 1 ? 's' : '') : '') + (n > MAX_SHOWN ? ', ' + MAX_SHOWN + ' premières affichées' : '') : '';
  $('practiceSel').disabled = !n;
  if (!n) {
    ul.innerHTML = '<li class="empty">' + (filtered ? 'Aucune carte ne correspond.' : 'Aucune carte pour l\'instant.') + '</li>';
    return;
  }
  results.slice(0, MAX_SHOWN).forEach(({ chapter, card }) => {
    const st = S.stateOf(state.progress, S.cardKey(chapter, card));
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = '<span class="q-wrap"><span class="where"></span><span class="q"></span></span><span class="meta">' +
      [S.BUCKETS[S.bucketOf(st)], ...flagsOf(card)].map(escapeHtml).join(' · ') + '</span>';
    b.querySelector('.where').textContent = chapter.matiereNom + ' · ' + chapter.nom;
    b.querySelector('.q').innerHTML = escapeHtml(card.q);
    b.addEventListener('click', () => { state.editReturn = null; openEditor(chapter, card); });
    li.appendChild(b);
    ul.appendChild(li);
  });
  typeset(ul);
}

// =====================================================================
// Éditeur
// =====================================================================
function chapterOptions(selected) {
  const sel = $('fChapter');
  sel.innerHTML = '';
  state.matieres.forEach((m) => {
    if (!m.chapitres.length) return;
    const og = document.createElement('optgroup');
    og.label = m.nom;
    m.chapitres.forEach((ch) => {
      const o = document.createElement('option');
      o.value = ch.id;
      o.textContent = ch.nom;
      og.appendChild(o);
    });
    sel.appendChild(og);
  });
  sel.value = selected || (state.chapters[0] && state.chapters[0].id) || '';
}

function readForm() {
  return {
    q: $('fQ').value, r: $('fR').value,
    inverse: $('fInverse').checked, mode: $('fMode').value,
    attendu: $('fAttendu').value, choix: $('fChoix').value,
  };
}
function formOf(card) {
  return {
    q: card ? card.q : '', r: card ? card.r : '',
    inverse: !!(card && card.inverse), mode: (card && card.mode) || '',
    attendu: (card && card.attendu) || '', choix: (card && Array.isArray(card.choix) ? card.choix.join('\n') : ''),
  };
}

// slide : 'from-right' (carte suivante), 'from-left' (carte précédente) ou rien.
export function openEditor(ch, card, slide) {
  const form = formOf(card);
  state.edit = {
    chId: ch.id,
    cardId: card ? card.id : null,
    img_q: card ? card.img_q || null : null,
    img_r: card ? card.img_r || null : null,
    orig: { ...form, img_q: card ? card.img_q || null : null, img_r: card ? card.img_r || null : null },
    uploads: {}, // côté ('q' ou 'r') -> { path, base64 }
    busy: false,
  };
  state.discardUntil = 0;
  setEditorBusy(false);
  $('fQ').value = form.q;
  $('fR').value = form.r;
  $('fInverse').checked = form.inverse;
  $('fMode').value = form.mode;
  $('fAttendu').value = form.attendu;
  $('fChoix').value = form.choix;
  chapterOptions(ch.id);
  $('fChapterBox').hidden = !!card;
  $('fDelete').hidden = !card;
  $('deleteConfirm').hidden = true;
  setStatus('fStatus', card ? ch.matiereNom + ' · ' + ch.nom : '');
  renderImgPreview('q');
  renderImgPreview('r');
  updateModeFields();
  renderCardStats(ch, card);
  updateEditorNav();
  const body = $('editBody');
  body.classList.remove('from-right', 'from-left');
  if (slide) { void body.offsetWidth; body.classList.add(slide); }
  if ($('view-carte').hidden) showView('carte');
  clearTimeout(previewTimer);
  renderPreview();
}

function updateModeFields() {
  const mode = $('fMode').value;
  $('fAttenduBox').hidden = mode === 'trou';
  $('fChoixBox').hidden = mode !== 'qcm';
  $('fTrouHelp').hidden = mode !== 'trou';
  $('fInverse').disabled = mode === 'trou';
  $('fR').placeholder = mode === 'trou' ? 'Facultatif : traduction ou explication' : 'Formule centrée : $$ ... $$';
  $('fAttendu').placeholder = 'Par défaut : ' + (firstLine($('fR').value) || 'première ligne de la réponse');
}

function stateLabel(st) {
  if (!st) return 'Jamais vue';
  if (st.state === 'learning') return 'En apprentissage';
  if (st.state === 'relearning') return 'En réapprentissage';
  return st.ivl >= 21 ? 'Acquise' : 'Jeune';
}
function renderCardStats(ch, card) {
  const box = $('fStats');
  if (!card) { box.hidden = true; return; }
  const day = S.today();
  const rows = S.faces(ch).filter((f) => f.card.id === card.id).map((f) => {
    const st = S.stateOf(state.progress, f.key);
    const cells = [stateLabel(st)];
    if (st) {
      if (st.state === 'review') {
        const R = retrievability(Math.max(0, S.daysBetween(st.lastDay, day)), st.S);
        cells.push('intervalle ' + S.formatDays(st.ivl), 'prochaine le ' + new Date(st.due + 'T12:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
          'mémoire estimée ' + Math.round(R * 100) + ' %');
      }
      cells.push(plural(st.n || 0, 'révision', 'révisions'), plural(st.l || 0, 'oubli', 'oublis'),
        'difficulté ' + Math.round(((st.D || 5) - 1) / 9 * 100) + ' %');
    }
    return '<div class="cs-row"><b>' + (f.rev ? 'Réponse → question' : 'Question → réponse') + '</b><span>' + cells.map(escapeHtml).join(' · ') + '</span></div>';
  });
  box.innerHTML = '<h3>Suivi de la carte</h3>' + rows.join('');
  box.hidden = false;
}

function updateEditorNav() {
  const ed = state.edit;
  const fromSession = state.editReturn === 'session' || state.editReturn === 'classeur';
  const i = !fromSession && ed.cardId ? results.findIndex((x) => x.card.id === ed.cardId && x.chapter.id === ed.chId) : -1;
  $('editTitle').textContent = fromSession ? 'Modifier la carte' : i >= 0 ? 'Carte ' + (i + 1) + ' / ' + results.length : (ed.cardId ? 'Modifier la carte' : 'Nouvelle carte');
  $('editPrev').hidden = $('editNext').hidden = fromSession;
  $('editPrev').disabled = ed.busy || i <= 0;
  $('editNext').disabled = ed.busy || i < 0 || i >= results.length - 1;
  $('swipeHint').hidden = i < 0 || results.length < 2;
  $('editBack').textContent = state.editReturn === 'session' ? 'Retour à la révision' : state.editReturn === 'classeur' ? 'Retour au document' : 'Retour';
}

function isEditorDirty() {
  const ed = state.edit;
  if (!ed) return false;
  const f = readForm();
  return Object.keys(f).some((k) => f[k] !== ed.orig[k]) || ed.img_q !== ed.orig.img_q || ed.img_r !== ed.orig.img_r;
}

function goToCard(dir) {
  const ed = state.edit;
  if (!ed || ed.busy || !ed.cardId || state.editReturn === 'session') return;
  const i = results.findIndex((x) => x.card.id === ed.cardId && x.chapter.id === ed.chId);
  const target = results[i + dir];
  if (i < 0 || !target) return;
  if (isEditorDirty() && Date.now() > state.discardUntil) {
    state.discardUntil = Date.now() + 4000;
    toast('Modifications non enregistrées. Enregistre-les, ou recommence pour les abandonner.');
    return;
  }
  openEditor(target.chapter, target.card, dir > 0 ? 'from-right' : 'from-left');
}

function closeEditor(card) {
  state.edit = null;
  if (state.editReturn === 'session') return resumeSession(card);
  if (state.editReturn === 'classeur') return returnToViewer();
  route();
}

function bindSwipe() {
  const view = $('view-carte');
  let start = null;
  view.addEventListener('touchstart', (e) => {
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
function renderPreview() {
  if (!state.edit) return;
  if ($('fMode').value === 'trou') {
    const c = faceContent({ card: { q: $('fQ').value, r: $('fR').value, mode: 'trou' }, rev: false });
    renderFace($('pQ'), c.q, state.edit.img_q);
    renderFace($('pR'), c.r, state.edit.img_r);
    return;
  }
  renderFace($('pQ'), $('fQ').value, state.edit.img_q);
  renderFace($('pR'), $('fR').value, state.edit.img_r);
}
function updatePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 250);
  updateModeFields();
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

function setEditorBusy(busy) {
  if (state.edit) state.edit.busy = busy;
  ['fSave', 'fDelete', 'fDeleteYes', 'editBack'].forEach((id) => { $(id).disabled = busy; });
  if (busy) { $('editPrev').disabled = true; $('editNext').disabled = true; }
}

async function saveCard() {
  const ed = state.edit;
  if (!ed || ed.busy) return;
  const ch = ed.cardId ? state.byId.get(ed.chId) : state.byId.get($('fChapter').value);
  const f = readForm();
  const q = f.q.trim(), r = f.r.trim();
  if (!ch) { setStatus('fStatus', 'Choisis un chapitre.', 'error'); return; }
  const cloze = f.mode === 'trou';
  if (!q || (!r && !cloze)) { setStatus('fStatus', 'La question et la réponse sont obligatoires.', 'error'); return; }
  if (cloze && !/\{\{.+?\}\}/.test(q)) { setStatus('fStatus', 'Entoure au moins un mot de doubles accolades : {{mot}}.', 'error'); return; }
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
    const old = ed.cardId ? ch.cartes.find((c) => c.id === ed.cardId) || {} : {};
    const card = { ...old, id: ed.cardId || newId(), q, r };
    const setOpt = (k, v) => { if (v) card[k] = v; else delete card[k]; };
    setOpt('img_q', ed.img_q);
    setOpt('img_r', ed.img_r);
    setOpt('inverse', (f.inverse && !cloze) || null);
    setOpt('mode', f.mode || null);
    setOpt('attendu', cloze ? null : f.attendu.trim());
    const choix = f.choix.split('\n').map((x) => x.trim()).filter(Boolean);
    setOpt('choix', f.mode === 'qcm' && choix.length ? choix : null);
    const isNew = !ed.cardId;
    await updateChapterFile(ch, (list) => {
      const i = list.findIndex((c) => c.id === card.id);
      if (i >= 0) list[i] = card; else list.push(card);
      return list;
    }, (isNew ? 'Ajoute' : 'Modifie') + ' une carte : ' + ch.nom);
    toast(isNew ? 'Carte ajoutée.' : 'Carte enregistrée.');
    const saved = ch.cartes.find((c) => c.id === card.id) || card;
    if (state.editReturn === 'session' || state.editReturn === 'classeur') return closeEditor(saved);
    if (isNew) results = filteredCards();
    openEditor(ch, saved); // on reste sur la carte pour pouvoir continuer à défiler
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
  const pos = results.findIndex((x) => x.card.id === ed.cardId && x.chapter.id === ed.chId);
  try {
    await updateChapterFile(ch, (list) => list.filter((c) => c.id !== ed.cardId), 'Supprime une carte : ' + ch.nom);
    toast('Carte supprimée.');
    if (state.editReturn === 'session') return closeEditor(null);
    results = filteredCards();
    const next = results[Math.min(Math.max(pos, 0), results.length - 1)];
    if (next) openEditor(next.chapter, next.card, 'from-right');
    else closeEditor();
  } catch (e) {
    setStatus('fStatus', 'Échec de la suppression : ' + e.message, 'error');
    setEditorBusy(false);
  }
}

async function createChapter() {
  const mat = $('ncMatiere').value;
  const nom = $('ncNom').value.trim();
  if (!nom) { toast('Donne un nom au chapitre.'); return; }
  $('ncCreate').disabled = true;
  try {
    const ch = await createChapterFile(mat, nom);
    filters.mat = mat;
    filters.chap = ch.id;
    $('ncNom').value = '';
    $('newChapterForm').hidden = true;
    toast('Chapitre créé.');
    renderCartes();
  } catch (e) {
    toast(e.message.startsWith('Ce chapitre') ? e.message : 'Échec de la création : ' + e.message);
  } finally {
    $('ncCreate').disabled = false;
  }
}

// Affiche les cartes d'un chapitre dans l'onglet Cartes (après un import, par exemple).
export function showChapterCards(ch) {
  Object.assign(filters, { text: '', mat: ch.matiere, chap: ch.id, etat: '', type: '' });
  state.editReturn = null;
  if (location.hash.slice(1) !== 'cartes') location.hash = 'cartes';
  else route();
}

export function bindEditor() {
  let searchTimer;
  $('cardSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { filters.text = $('cardSearch').value; renderCardList(); }, 200);
  });
  $('fMat').addEventListener('change', () => { filters.mat = $('fMat').value; filters.chap = ''; renderCartes(); });
  $('fChap').addEventListener('change', () => { filters.chap = $('fChap').value; renderCardList(); });
  $('fEtat').addEventListener('change', () => { filters.etat = $('fEtat').value; renderCardList(); });
  $('fType').addEventListener('change', () => { filters.type = $('fType').value; renderCardList(); });
  $('filtersReset').addEventListener('click', () => {
    Object.assign(filters, { text: '', mat: '', chap: '', etat: '', type: '' });
    renderCartes();
  });
  $('practiceSel').addEventListener('click', () => {
    const items = filteredCards().flatMap(({ chapter, card }) => S.faces(chapter).filter((f) => f.card === card));
    startPractice(items, 'cram');
  });
  $('newCard').addEventListener('click', () => {
    const ch = state.byId.get(filters.chap) || state.chapters.find((c) => !filters.mat || c.matiere === filters.mat);
    if (!ch) return;
    state.editReturn = null;
    openEditor(ch, null);
  });
  $('newChapter').addEventListener('click', () => {
    $('newChapterForm').hidden = false;
    if (filters.mat) $('ncMatiere').value = filters.mat;
    $('ncNom').focus();
  });
  $('ncCancel').addEventListener('click', () => { $('newChapterForm').hidden = true; });
  $('ncCreate').addEventListener('click', createChapter);

  $('editBack').addEventListener('click', () => {
    if (isEditorDirty() && Date.now() > state.discardUntil) {
      state.discardUntil = Date.now() + 4000;
      toast('Modifications non enregistrées. Appuie à nouveau sur Retour pour les abandonner.');
      return;
    }
    closeEditor(undefined);
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
  $('fMode').addEventListener('change', () => { updateModeFields(); renderPreview(); });
  $('fImgQ').addEventListener('change', (e) => pickImage('q', e.target));
  $('fImgR').addEventListener('change', (e) => pickImage('r', e.target));
  $('fImgQDel').addEventListener('click', () => removeImage('q'));
  $('fImgRDel').addEventListener('click', () => removeImage('r'));
  $('fSave').addEventListener('click', saveCard);
  $('fDelete').addEventListener('click', () => { $('deleteConfirm').hidden = false; });
  $('fDeleteNo').addEventListener('click', () => { $('deleteConfirm').hidden = true; });
  $('fDeleteYes').addEventListener('click', deleteCard);
}

// Ouvre une carte depuis un autre onglet (par exemple la liste des cartes difficiles).
export function openFromElsewhere(chapter, card) {
  history.replaceState(null, '', '#cartes'); // change d'onglet sans déclencher de nouvel affichage
  renderCartes();
  state.editReturn = null;
  openEditor(chapter, card);
}
