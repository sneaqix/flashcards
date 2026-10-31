// Import d'un cours en PDF : génération des cartes par Gemini, relecture, puis ajout dans un chapitre.
import * as G from './gemini.js?v=20261031225520';
import {
  $, state, escapeHtml, renderFace, typeset, toast, setStatus, plural, canEdit, newId, showView,
  faceContent, route, canSync,
} from './ui.js?v=20261031225520';
import { updateChapterFile, createChapterFile } from './sync.js?v=20261031225520';
import { addDocument } from './classeur.js?v=20261031225520';
import { showChapterCards } from './editor.js?v=20261031225520';

const MAX_MB = 30;
const TYPES = ['classique', 'qcm', 'trou', 'saisie'];
const FOCUS = ['definitions', 'formules', 'methodes', 'pieges'];
const TYPE_NAMES = { classique: 'Classique', qcm: 'QCM', trou: 'Texte à trous', saisie: 'Réponse à taper' };

let pdfFile = null;
let draft = null;     // { titre, fileName, mat, dest, newName, chap, cards: [{ keep, card }] }
let abort = null;
let running = false;  // génération en cours
let hiddenDuring = false; // la page a été quittée pendant la génération
let userCancel = false;
let pendingJob = null;
let importDocId = null; // document du classeur utilisé pour l'import (pas besoin de le ranger à nouveau) // génération interrompue, à relancer au retour sur la page
let wakeLock = null;

// ---------- Conservation sur l'appareil ----------
// La relecture en cours est gardée dans le stockage local ; la génération en attente (avec le PDF,
// trop gros pour le stockage local) est gardée dans IndexedDB.
const LS_DRAFT = 'fc.importDraft';
function saveDraft() {
  try {
    if (draft) localStorage.setItem(LS_DRAFT, JSON.stringify(draft));
    else localStorage.removeItem(LS_DRAFT);
  } catch (e) { /* stockage indisponible ou plein */ }
  updateImportBanner();
}
function loadDraft() {
  try { return JSON.parse(localStorage.getItem(LS_DRAFT)) || null; } catch (e) { return null; }
}
let draftTimer;
function saveDraftSoon() { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 400); }

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('fc-import', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function jobStore(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => { db.close(); resolve(req && req.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
const saveJob = (job) => jobStore('readwrite', (st) => st.put(job, 'job')).catch(() => {});
const loadJob = () => jobStore('readonly', (st) => st.get('job')).catch(() => null);
const clearJob = () => jobStore('readwrite', (st) => st.delete('job')).catch(() => {});
// PDF de la relecture en cours, rangé dans le classeur au moment de l'ajout des cartes.
const saveDraftPdf = (p) => jobStore('readwrite', (st) => st.put(p, 'draftPdf')).catch(() => {});
const loadDraftPdf = () => jobStore('readonly', (st) => st.get('draftPdf')).catch(() => null);
const clearDraftPdf = () => jobStore('readwrite', (st) => st.delete('draftPdf')).catch(() => {});

// ---------- Écran allumé pendant la génération ----------
async function keepAwake() {
  try { if (navigator.wakeLock && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }
}
function releaseAwake() {
  try { if (wakeLock) wakeLock.release(); } catch (e) { /* déjà libéré */ }
  wakeLock = null;
}

// Bandeau de l'onglet Cartes quand une relecture ou une génération attend.
export function updateImportBanner() {
  const box = $('impPending');
  if (!box) return;
  if (draft) {
    const kept = draft.cards.filter((c) => c.keep).length;
    $('impPendingText').textContent = 'Relecture en attente : ' + plural(draft.cards.length, 'carte générée', 'cartes générées') + ' depuis « ' + draft.fileName + ' » (' + kept + ' gardée' + (kept > 1 ? 's' : '') + ').';
    box.hidden = false;
  } else if (running || pendingJob) {
    $('impPendingText').textContent = 'Génération en cours depuis « ' + ((pendingJob && pendingJob.fileName) || (pdfFile && pdfFile.name) || 'ton PDF') + ' ».';
    box.hidden = false;
  } else {
    box.hidden = true;
  }
}

// Ouvre l'import avec un document du classeur déjà choisi.
export function openImportWithDoc(doc, file) {
  openImport();
  if (draft || running || pendingJob) { toast('Termine d\'abord l\'import en cours.'); return; }
  pdfFile = file;
  importDocId = doc.id;
  $('impFileName').textContent = doc.nom + ' (classeur)';
  $('impPick').textContent = 'Changer de PDF';
  const ch = state.byId.get(doc.chapId);
  if (ch) {
    $('impMat').value = ch.matiere;
    fillChapters();
    $('impDestOld').checked = true;
    $('impChap').value = ch.id;
    updateDest();
  }
  setStatus('impStatus', '');
  updateGenerate();
}

export function openImport() {
  history.replaceState(null, '', '#cartes');
  state.editReturn = null;
  renderImport();
  showView('import');
}

function fillMatieres() {
  const sel = $('impMat');
  const prev = sel.value;
  sel.innerHTML = state.matieres.map((m) => '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.nom) + '</option>').join('');
  if (prev && state.matieres.some((m) => m.id === prev)) sel.value = prev;
  fillChapters();
}
function fillChapters() {
  const mat = $('impMat').value;
  const chaps = state.chapters.filter((c) => c.matiere === mat);
  $('impChap').innerHTML = chaps.map((c) => '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.nom) + ' (' + c.cartes.length + ')</option>').join('');
  $('impDestOld').disabled = !chaps.length;
  if (!chaps.length) $('impDestNew').checked = true;
  updateDest();
}
function updateDest() {
  const isNew = $('impDestNew').checked;
  $('impNewBox').hidden = !isNew;
  $('impChapBox').hidden = isNew;
}

function renderImport() {
  const key = state.config.geminiKey;
  const problems = [];
  if (!key) problems.push('ta clé API Gemini');
  if (!canEdit()) problems.push('ton jeton GitHub');
  $('impLocked').hidden = !problems.length;
  $('impLockedText').textContent = 'Pour générer des cartes, renseigne ' + problems.join(' et ') + ' dans les réglages.';
  fillMatieres();
  if (draft) restoreDest();
  showStep(draft ? 'review' : running || pendingJob ? 'wait' : 'setup');
  if (draft) renderReview();
  updateGenerate();
}

// Remet les choix de destination enregistrés avec la relecture.
function restoreDest() {
  if (draft.mat && state.matieres.some((m) => m.id === draft.mat)) { $('impMat').value = draft.mat; fillChapters(); }
  if (draft.dest === 'old' && !$('impDestOld').disabled) $('impDestOld').checked = true; else $('impDestNew').checked = true;
  if (draft.chap && state.byId.has(draft.chap)) $('impChap').value = draft.chap;
  $('impNewName').value = draft.newName || draft.titre || '';
  updateDest();
}
function rememberDest() {
  if (!draft) return;
  draft.mat = $('impMat').value;
  draft.dest = $('impDestNew').checked ? 'new' : 'old';
  draft.newName = $('impNewName').value;
  draft.chap = $('impChap').value;
  saveDraftSoon();
}

function showStep(step) {
  $('impSetup').hidden = step !== 'setup';
  $('impSetup2').hidden = step !== 'setup';
  $('impDest').hidden = step === 'wait';
  $('impWait').hidden = step !== 'wait';
  $('impReview').hidden = step !== 'review';
}

function selected(prefix, list) {
  return list.filter((x) => $(prefix + x).checked);
}
function updateGenerate() {
  const ok = pdfFile && state.config.geminiKey && canEdit() && selected('impT-', TYPES).length && selected('impF-', FOCUS).length;
  $('impGo').disabled = !ok;
}

function pickPdf(input) {
  const f = input.files && input.files[0];
  input.value = '';
  if (!f) return;
  if (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) { setStatus('impStatus', 'Choisis un fichier PDF.', 'error'); return; }
  if (f.size > MAX_MB * 1024 * 1024) { setStatus('impStatus', 'Ce PDF dépasse ' + MAX_MB + ' Mo : découpe-le en plusieurs parties.', 'error'); return; }
  pdfFile = f;
  importDocId = null;
  $('impFileName').textContent = f.name + ' · ' + (f.size / 1048576).toFixed(1).replace('.', ',') + ' Mo';
  $('impPick').textContent = 'Changer de PDF';
  if (!$('impNewName').value) $('impNewName').placeholder = 'Par défaut : titre proposé par Gemini';
  setStatus('impStatus', '');
  updateGenerate();
}

async function generate() {
  if (!pdfFile || running) return;
  const mat = state.matieres.find((m) => m.id === $('impMat').value);
  let pdfBase64;
  try { pdfBase64 = await G.fileToBase64(pdfFile); } catch (e) { setStatus('impStatus', e.message, 'error'); return; }
  const job = {
    fileName: pdfFile.name, pdfBase64,
    count: Number($('impCount').value) || 0,
    types: selected('impT-', TYPES),
    focus: selected('impF-', FOCUS),
    matiereNom: mat ? mat.nom : '',
    consignes: $('impConsignes').value.trim(),
    mat: $('impMat').value,
    dest: $('impDestNew').checked ? 'new' : 'old',
    newName: $('impNewName').value.trim(),
    chap: $('impChap').value,
    docId: importDocId,
    size: pdfFile.size,
  };
  await saveJob(job); // permet de reprendre même si la page est fermée
  runJob(job);
}

async function runJob(job) {
  if (running) return;
  running = true;
  hiddenDuring = document.visibilityState === 'hidden';
  userCancel = false;
  pendingJob = null;
  updateImportBanner();
  showStep('wait');
  $('impWaitText').textContent = 'Gemini lit « ' + job.fileName + ' » et prépare les cartes. Cela prend en général entre 30 secondes et 2 minutes. Reste sur cette page : l\'écran restera allumé.';
  keepAwake();
  abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 240000);
  try {
    const res = await G.generateCards({
      key: state.config.geminiKey,
      model: state.config.geminiModel || G.DEFAULT_MODEL,
      pdfBase64: job.pdfBase64,
      count: job.count, types: job.types, focus: job.focus,
      matiere: job.matiereNom, consignes: job.consignes,
      signal: abort.signal,
    });
    const cards = res.cartes.map((g) => G.toDeckCard(g, newId())).filter((c) => c.q);
    if (!cards.length) throw new G.GeminiError('Gemini n\'a proposé aucune carte exploitable. Réessaie avec d\'autres consignes.', 200);
    const titre = String(res.titre || '').trim();
    draft = {
      titre, fileName: job.fileName, mat: job.mat, dest: job.dest, chap: job.chap,
      newName: job.newName || titre,
      docId: job.docId || null,
      cards: cards.map((card) => ({ keep: true, card })),
    };
    saveDraft();
    if (!job.docId) await saveDraftPdf({ base64: job.pdfBase64, size: job.size || Math.round(job.pdfBase64.length * 0.75), fileName: job.fileName });
    clearJob();
    pdfFile = null;
    if (!$('view-import').hidden) {
      restoreDest();
      showStep('review');
      renderReview();
    } else {
      toast('Cartes générées : ouvre l\'import pour les relire.');
    }
  } catch (e) {
    // Interrompue parce que la page a été quittée (iPhone) : on relancera au retour.
    const interrupted = !userCancel && (hiddenDuring || document.visibilityState === 'hidden') && !(e instanceof G.GeminiError && e.status);
    if (interrupted) {
      pendingJob = job;
      showStep('wait');
      $('impWaitText').textContent = 'La génération a été interrompue parce que tu as quitté la page. Elle reprend automatiquement.';
      if (document.visibilityState === 'visible') setTimeout(resumeIfPending, 500);
    } else {
      clearJob();
      showStep('setup');
      setStatus('impStatus', userCancel ? 'Génération annulée.' : e.message, userCancel ? '' : 'error');
    }
  } finally {
    clearTimeout(timer);
    abort = null;
    running = false;
    if (!pendingJob) releaseAwake();
    updateImportBanner();
  }
}

async function resumeIfPending() {
  if (running) return;
  const job = pendingJob || await loadJob();
  if (!job || !job.pdfBase64) return;
  pendingJob = job;
  if (!state.config.geminiKey) return;
  if ($('view-import').hidden && !state.session && !state.assoc) openImport();
  runJob(job);
}

// À l'ouverture de l'appli : reprend une relecture ou une génération laissée en plan.
export async function restoreImport() {
  draft = loadDraft();
  updateImportBanner();
  if (draft) return;
  const job = await loadJob();
  if (job && job.pdfBase64) {
    pendingJob = job;
    updateImportBanner();
    resumeIfPending();
  }
}

// ---------- Relecture ----------
function cardFromBlock(block, base) {
  const type = block.querySelector('.ir-type').value;
  const q = block.querySelector('.ir-q').value.trim();
  const r = block.querySelector('.ir-r').value.trim();
  const attendu = block.querySelector('.ir-att').value.trim();
  const choix = block.querySelector('.ir-choix').value.split('\n').map((x) => x.trim()).filter(Boolean);
  const card = { id: base.id, q, r };
  if (type === 'qcm') { card.mode = 'qcm'; if (attendu) card.attendu = attendu; if (choix.length) card.choix = choix; }
  else if (type === 'trou') card.mode = 'trou';
  else if (type === 'saisie') { card.mode = 'saisie'; if (attendu) card.attendu = attendu; }
  else if (attendu) card.attendu = attendu;
  return card;
}

function typeOf(card) { return card.mode === 'qcm' ? 'qcm' : card.mode === 'trou' ? 'trou' : card.mode === 'saisie' ? 'saisie' : 'classique'; }

function renderBlockPreview(block, card) {
  const prev = block.querySelector('.ir-preview');
  const c = faceContent({ card, rev: false });
  let html = '<div class="ir-pq"></div>';
  if (card.mode === 'qcm') {
    const opts = [card.attendu || c.r.split('\n')[0], ...(card.choix || [])];
    html += '<ul class="ir-opts">' + opts.map((o, i) => '<li class="' + (i === 0 ? 'ok' : '') + '">' + escapeHtml(o) + '</li>').join('') + '</ul>';
  }
  html += '<div class="ir-pr"></div>';
  prev.innerHTML = html;
  prev.querySelector('.ir-pq').textContent = c.q;
  prev.querySelector('.ir-pr').textContent = c.r;
  prev.querySelectorAll('.ir-pq, .ir-pr').forEach((el) => { el.innerHTML = el.innerHTML.replace(/\n/g, '<br>'); });
  typeset(prev);
}

function updateBlockFields(block) {
  const type = block.querySelector('.ir-type').value;
  block.querySelector('.ir-att-box').hidden = type === 'trou';
  block.querySelector('.ir-choix-box').hidden = type !== 'qcm';
  block.querySelector('.ir-att-label').textContent = type === 'saisie' ? 'Réponse attendue' : type === 'qcm' ? 'Bonne réponse (courte)' : 'Réponse courte (associations)';
}

function renderReview() {
  const list = $('impList');
  list.innerHTML = '';
  draft.cards.forEach((entry, i) => {
    const { card } = entry;
    const li = document.createElement('li');
    li.className = 'ir' + (entry.keep ? '' : ' off');
    li.innerHTML =
      '<div class="ir-head">' +
        '<label class="check"><input type="checkbox" class="ir-keep" id="ir-keep-' + i + '"> Carte ' + (i + 1) + '</label>' +
        '<select class="ir-type" aria-label="Type de la carte ' + (i + 1) + '">' + TYPES.map((t) => '<option value="' + t + '">' + TYPE_NAMES[t] + '</option>').join('') + '</select>' +
      '</div>' +
      '<div class="ir-preview card"></div>' +
      '<details class="ir-edit"><summary>Modifier</summary>' +
        '<label>Question<textarea class="ir-q" rows="2"></textarea></label>' +
        '<label>Réponse<textarea class="ir-r" rows="2"></textarea></label>' +
        '<label class="ir-att-box"><span class="ir-att-label"></span><input class="ir-att" type="text" autocomplete="off"></label>' +
        '<label class="ir-choix-box">Mauvaises réponses, une par ligne<textarea class="ir-choix" rows="3"></textarea></label>' +
      '</details>';
    li.querySelector('.ir-keep').checked = entry.keep;
    li.querySelector('.ir-type').value = typeOf(card);
    li.querySelector('.ir-q').value = card.q;
    li.querySelector('.ir-r').value = card.r || '';
    li.querySelector('.ir-att').value = card.attendu || '';
    li.querySelector('.ir-choix').value = (card.choix || []).join('\n');
    updateBlockFields(li);
    let t;
    const onEdit = () => {
      entry.card = cardFromBlock(li, entry.card);
      saveDraftSoon();
      updateBlockFields(li);
      clearTimeout(t);
      t = setTimeout(() => renderBlockPreview(li, entry.card), 300);
    };
    li.querySelectorAll('textarea, input[type="text"]').forEach((el) => el.addEventListener('input', onEdit));
    li.querySelector('.ir-type').addEventListener('change', onEdit);
    li.querySelector('.ir-keep').addEventListener('change', (e) => {
      entry.keep = e.target.checked;
      li.classList.toggle('off', !entry.keep);
      saveDraftSoon();
      updateReviewCount();
    });
    list.appendChild(li);
    // Les formules doivent être mises en forme une fois la carte dans la page : sinon la taille
    // du texte est inconnue et les symboles sont dessinés de façon démesurée.
    renderBlockPreview(li, card);
  });
  updateReviewCount();
}

function updateReviewCount() {
  const n = draft.cards.length;
  const kept = draft.cards.filter((c) => c.keep).length;
  $('impCount2').textContent = plural(n, 'carte proposée', 'cartes proposées') + ' à partir de « ' + draft.fileName + ' » · ' + kept + (kept > 1 ? ' gardées' : ' gardée');
  $('impSave').textContent = kept ? 'Ajouter ' + plural(kept, 'carte', 'cartes') : 'Aucune carte cochée';
  $('impSave').disabled = !kept;
}

function cardIsValid(card) {
  if (!card.q) return false;
  if (card.mode === 'trou') return /\{\{.+?\}\}/.test(card.q);
  return !!(card.r || card.attendu);
}

async function save() {
  const kept = draft.cards.filter((c) => c.keep).map((c) => c.card);
  const bad = kept.findIndex((c) => !cardIsValid(c));
  if (bad >= 0) {
    setStatus('impSaveStatus', 'Une carte cochée est incomplète (question ou réponse vide, ou texte à trous sans {{…}}). Corrige-la ou décoche-la.', 'error');
    return;
  }
  $('impSave').disabled = true;
  setStatus('impSaveStatus', 'Enregistrement sur GitHub…');
  try {
    let ch;
    if ($('impDestNew').checked) {
      const nom = $('impNewName').value.trim() || draft.titre || draft.fileName.replace(/\.pdf$/i, '');
      ch = state.byId.get($('impMat').value + '-' + nom.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40));
      if (!ch) ch = await createChapterFile($('impMat').value, nom);
    } else {
      ch = state.byId.get($('impChap').value);
    }
    await updateChapterFile(ch, (list) => [...list, ...kept], 'Ajoute ' + plural(kept.length, 'carte générée', 'cartes générées') + ' depuis ' + draft.fileName);
    let stored = '';
    if (!draft.docId) {
      // Le cours importé est rangé dans le classeur, dans le même chapitre que ses cartes.
      const pdf = await loadDraftPdf();
      if (pdf && pdf.base64 && canSync()) {
        setStatus('impSaveStatus', 'Rangement du cours dans le classeur…');
        try {
          await addDocument({ base64: pdf.base64, size: pdf.size, nom: draft.fileName.replace(/\.pdf$/i, ''), type: 'cours', chapId: ch.id, matiere: ch.matiere });
          stored = ' Le cours est rangé dans le classeur.';
        } catch (e) {
          stored = ' Le PDF n\'a pas pu être rangé dans le classeur (' + e.message + ').';
        }
      }
    }
    clearDraftPdf();
    toast(plural(kept.length, 'carte ajoutée', 'cartes ajoutées') + ' à « ' + ch.nom + ' ».' + stored);
    draft = null;
    saveDraft();
    pdfFile = null;
    resetSetup();
    showChapterCards(ch);
  } catch (e) {
    setStatus('impSaveStatus', 'Échec de l\'enregistrement : ' + e.message, 'error');
    $('impSave').disabled = false;
  }
}

function resetSetup() {
  $('impFileName').textContent = 'Aucun fichier choisi';
  $('impPick').textContent = 'Choisir un PDF';
  $('impNewName').value = '';
  $('impConsignes').value = '';
  setStatus('impStatus', '');
  setStatus('impSaveStatus', '');
}

function discard() {
  draft = null;
  saveDraft();
  clearDraftPdf();
  $('impDiscardConfirm').hidden = true;
  setStatus('impSaveStatus', '');
  showStep('setup');
  updateGenerate();
}

export function bindImport() {
  if ($('importBtn')) $('importBtn').addEventListener('click', openImport);
  $('impBack').addEventListener('click', () => route()); // la génération continue tant que l'appli reste ouverte
  $('impFile').addEventListener('change', (e) => pickPdf(e.target));
  $('impMat').addEventListener('change', fillChapters);
  $('impDestNew').addEventListener('change', updateDest);
  $('impDestOld').addEventListener('change', updateDest);
  [...TYPES.map((t) => 'impT-' + t), ...FOCUS.map((f) => 'impF-' + f)].forEach((id) => $(id).addEventListener('change', updateGenerate));
  $('impGo').addEventListener('click', generate);
  $('impCancel').addEventListener('click', () => {
    userCancel = true;
    if (abort) abort.abort();
    if (pendingJob && !running) { pendingJob = null; clearJob(); releaseAwake(); showStep('setup'); updateImportBanner(); }
  });
  $('impAll').addEventListener('click', () => { draft.cards.forEach((c) => { c.keep = true; }); saveDraft(); renderReview(); });
  $('impNone').addEventListener('click', () => { draft.cards.forEach((c) => { c.keep = false; }); saveDraft(); renderReview(); });
  ['impMat', 'impChap', 'impDestNew', 'impDestOld'].forEach((id) => $(id).addEventListener('change', rememberDest));
  $('impNewName').addEventListener('input', rememberDest);
  $('impResume').addEventListener('click', openImport);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (running) hiddenDuring = true;
    } else {
      if (running) keepAwake(); // iOS libère le verrou d'écran quand on quitte la page
      if (pendingJob && !running) resumeIfPending();
    }
  });
  $('impSave').addEventListener('click', save);
  $('impDiscard').addEventListener('click', () => { $('impDiscardConfirm').hidden = false; });
  $('impDiscardYes').addEventListener('click', discard);
  $('impDiscardNo').addEventListener('click', () => { $('impDiscardConfirm').hidden = true; });
}
