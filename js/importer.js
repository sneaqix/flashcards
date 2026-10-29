// Import d'un cours en PDF : génération des cartes par Gemini, relecture, puis ajout dans un chapitre.
import * as G from './gemini.js?v=20261029235805';
import {
  $, state, escapeHtml, renderFace, typeset, toast, setStatus, plural, canEdit, newId, showView,
  faceContent, route,
} from './ui.js?v=20261029235805';
import { updateChapterFile, createChapterFile } from './sync.js?v=20261029235805';
import { showChapterCards } from './editor.js?v=20261029235805';

const MAX_MB = 30;
const TYPES = ['classique', 'qcm', 'trou', 'saisie'];
const FOCUS = ['definitions', 'formules', 'methodes', 'pieges'];
const TYPE_NAMES = { classique: 'Classique', qcm: 'QCM', trou: 'Texte à trous', saisie: 'Réponse à taper' };

let pdfFile = null;
let draft = null;     // { titre, fileName, cards: [{ keep, card }] }
let abort = null;

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
  showStep(draft ? 'review' : 'setup');
  if (draft) renderReview();
  updateGenerate();
}

function showStep(step) {
  $('impSetup').hidden = step !== 'setup';
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
  $('impFileName').textContent = f.name + ' · ' + (f.size / 1048576).toFixed(1).replace('.', ',') + ' Mo';
  $('impPick').textContent = 'Changer de PDF';
  if (!$('impNewName').value) $('impNewName').placeholder = 'Par défaut : titre proposé par Gemini';
  setStatus('impStatus', '');
  updateGenerate();
}

async function generate() {
  if (!pdfFile) return;
  const mat = state.matieres.find((m) => m.id === $('impMat').value);
  showStep('wait');
  $('impWaitText').textContent = 'Gemini lit « ' + pdfFile.name + ' » et prépare les cartes. Cela prend en général entre 30 secondes et 2 minutes.';
  abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 240000);
  try {
    const pdfBase64 = await G.fileToBase64(pdfFile);
    const res = await G.generateCards({
      key: state.config.geminiKey,
      model: state.config.geminiModel || G.DEFAULT_MODEL,
      pdfBase64,
      count: Number($('impCount').value) || 0,
      types: selected('impT-', TYPES),
      focus: selected('impF-', FOCUS),
      matiere: mat ? mat.nom : '',
      consignes: $('impConsignes').value.trim(),
      signal: abort.signal,
    });
    const cards = res.cartes.map((g) => G.toDeckCard(g, newId())).filter((c) => c.q);
    if (!cards.length) throw new Error('Gemini n\'a proposé aucune carte exploitable. Réessaie avec d\'autres consignes.');
    draft = { titre: String(res.titre || '').trim(), fileName: pdfFile.name, mat: $('impMat').value, cards: cards.map((card) => ({ keep: true, card })) };
    if ($('impDestNew').checked && !$('impNewName').value.trim() && draft.titre) $('impNewName').value = draft.titre;
    showStep('review');
    renderReview();
  } catch (e) {
    showStep('setup');
    setStatus('impStatus', e.message, 'error');
  } finally {
    clearTimeout(timer);
    abort = null;
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
    renderBlockPreview(li, card);
    let t;
    const onEdit = () => {
      entry.card = cardFromBlock(li, entry.card);
      updateBlockFields(li);
      clearTimeout(t);
      t = setTimeout(() => renderBlockPreview(li, entry.card), 300);
    };
    li.querySelectorAll('textarea, input[type="text"]').forEach((el) => el.addEventListener('input', onEdit));
    li.querySelector('.ir-type').addEventListener('change', onEdit);
    li.querySelector('.ir-keep').addEventListener('change', (e) => {
      entry.keep = e.target.checked;
      li.classList.toggle('off', !entry.keep);
      updateReviewCount();
    });
    list.appendChild(li);
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
    toast(plural(kept.length, 'carte ajoutée', 'cartes ajoutées') + ' à « ' + ch.nom + ' ».');
    draft = null;
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
  $('impDiscardConfirm').hidden = true;
  setStatus('impSaveStatus', '');
  showStep('setup');
  updateGenerate();
}

export function bindImport() {
  $('importBtn').addEventListener('click', openImport);
  $('impBack').addEventListener('click', () => { if (abort) abort.abort(); route(); });
  $('impFile').addEventListener('change', (e) => pickPdf(e.target));
  $('impMat').addEventListener('change', fillChapters);
  $('impDestNew').addEventListener('change', updateDest);
  $('impDestOld').addEventListener('change', updateDest);
  [...TYPES.map((t) => 'impT-' + t), ...FOCUS.map((f) => 'impF-' + f)].forEach((id) => $(id).addEventListener('change', updateGenerate));
  $('impGo').addEventListener('click', generate);
  $('impCancel').addEventListener('click', () => { if (abort) abort.abort(); });
  $('impAll').addEventListener('click', () => { draft.cards.forEach((c) => { c.keep = true; }); renderReview(); });
  $('impNone').addEventListener('click', () => { draft.cards.forEach((c) => { c.keep = false; }); renderReview(); });
  $('impSave').addEventListener('click', save);
  $('impDiscard').addEventListener('click', () => { $('impDiscardConfirm').hidden = false; });
  $('impDiscardYes').addEventListener('click', discard);
  $('impDiscardNo').addEventListener('click', () => { $('impDiscardConfirm').hidden = true; });
}
