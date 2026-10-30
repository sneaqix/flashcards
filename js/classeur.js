// Onglet Classeur : documents PDF (cours, TD, DS) rangés par matière et chapitre,
// stockés dans le dépôt privé de sauvegarde.
import { isConflict } from './github.js?v=20261030232723';
import { fileToBase64 } from './gemini.js?v=20261030232723';
import { $, state, escapeHtml, toast, setStatus, plural, canSync, canEdit, newId, showView, route } from './ui.js?v=20261030232723';
import { createChapterFile, renameChapter, renameMatiere, reorderChapters, deleteChapter } from './sync.js?v=20261030232723';
import { openViewer } from './viewer.js?v=20261030232723';
import { openCitations, openResumes, oeuvresOf, citationsId, resumesId, countCitations, countResumes, loadCarnet } from './carnets.js?v=20261030232723';
import { openImportWithDoc } from './importer.js?v=20261030232723';

export const DOC_TYPES = { cours: 'Cours', td: 'TD / exercices', ds: 'DS / colles' };
const INDEX = 'classeur/index.json';
const MAX_MB = 25;

const filters = { text: '', type: '', chap: '', mat: readMat() };
// Matière choisie dans les puces, gardée d'une visite à l'autre sur cet appareil.
function readMat() { try { return localStorage.getItem('fc.clsMat') || ''; } catch (e) { return ''; } }
function writeMat(v) { try { localStorage.setItem('fc.clsMat', v); } catch (e) { /* indisponible */ } }
let editing = null; // document en cours de modification (null = ajout)
let pickedFile = null;

state.classeur = { docs: [], sha: null, loaded: false };
const pdfCache = new Map(); // id -> ArrayBuffer (pendant la visite)

// =====================================================================
// Données
// =====================================================================
export async function loadClasseur(force = false) {
  if (!canSync()) return;
  if (state.classeur.loaded && !force) return;
  const f = await state.gh.getFile(state.config.dataRepo, INDEX);
  state.classeur.docs = f ? (JSON.parse(f.text).docs || []) : [];
  state.classeur.sha = f ? f.sha : null;
  state.classeur.loaded = true;
}

// Modifie l'index du classeur sur GitHub (relecture et nouvel essai en cas de conflit).
async function updateIndex(mutate, message) {
  const { gh, config } = state;
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = await gh.getFile(config.dataRepo, INDEX);
    const docs = f ? (JSON.parse(f.text).docs || []) : [];
    const next = mutate(docs.map((d) => ({ ...d })));
    try {
      const sha = await gh.putFile(config.dataRepo, INDEX, JSON.stringify({ version: 1, docs: next }, null, 2) + '\n', f && f.sha, message);
      state.classeur.docs = next;
      state.classeur.sha = sha;
      state.classeur.loaded = true;
      return;
    } catch (e) {
      if (!isConflict(e) || attempt === 2) throw e;
    }
  }
}

// Ajoute un PDF au classeur. Renvoie le document créé.
export async function addDocument({ base64, size, nom, type, chapId, matiere }) {
  const id = newId();
  const file = 'classeur/files/' + id + '.pdf';
  const sha = await state.gh.putFile(state.config.dataRepo, file, base64, null, 'Classeur : ajoute « ' + nom + ' »', true);
  const doc = { id, nom, type, chapId, matiere, file, sha, size, added: Date.now() };
  await updateIndex((docs) => [...docs, doc], 'Classeur : range « ' + nom + ' »');
  pdfCache.set(id, base64ToBuffer(base64));
  return doc;
}

export function docsOfChapter(chId) {
  return state.classeur.docs.filter((d) => d.chapId === chId);
}

export async function getPdf(doc) {
  if (pdfCache.has(doc.id)) return pdfCache.get(doc.id);
  const buf = await state.gh.getBinary(state.config.dataRepo, doc.file);
  pdfCache.set(doc.id, buf);
  return buf;
}

function base64ToBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// =====================================================================
// Liste
// =====================================================================
function fmtSize(b) {
  return b >= 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' Mo' : Math.max(1, Math.round(b / 1024)) + ' Ko';
}
function fmtDate(ms) {
  return new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export async function renderClasseur() {
  const locked = !canSync() || !canEdit();
  $('clsLocked').hidden = !locked;
  $('clsAdd').disabled = locked;
  document.querySelectorAll('#clsTypes button').forEach((b) => b.classList.toggle('on', b.dataset.type === filters.type));
  renderMatChips();
  $('clsSearch').value = filters.text;
  $('clsChapFilter').hidden = !filters.chap;
  const ch = state.byId.get(filters.chap);
  $('clsChapFilterText').textContent = ch ? 'Chapitre : ' + ch.matiereNom + ' · ' + ch.nom : '';
  if (locked) { $('clsList').innerHTML = ''; return; }
  if (!state.classeur.loaded) {
    $('clsList').innerHTML = '<p class="sub">Chargement du classeur…</p>';
    try { await loadClasseur(); } catch (e) {
      $('clsList').innerHTML = '<p class="status error">Impossible de lire le classeur : ' + escapeHtml(e.message) + '</p>';
      return;
    }
  }
  renderList();
  preloadCarnets();
}

// Les carnets sont lus une fois en arrière-plan pour afficher leur nombre d'entrées.
let carnetsPreloaded = false;
function preloadCarnets() {
  if (carnetsPreloaded) return;
  carnetsPreloaded = true;
  const ids = [];
  state.matieres.forEach((m) => {
    if ((m.carnets || []).includes('resumes')) ids.push(resumesId(m.id));
    oeuvresOf(m.id).forEach((c) => ids.push(citationsId(c)));
  });
  if (ids.length) Promise.all(ids.map(loadCarnet)).then(() => { if (!$('view-classeur').hidden) renderList(); });
}

function carnetRow(label, sub, onOpen) {
  const li = document.createElement('li');
  li.className = 'cls-doc';
  li.innerHTML = '<button class="cls-open carnet" type="button"><span class="badge t-carnet">Carnet</span><span class="cls-name"></span><span class="cls-meta"></span></button>';
  li.querySelector('.cls-name').textContent = label;
  li.querySelector('.cls-meta').textContent = sub;
  li.querySelector('button').addEventListener('click', onOpen);
  return li;
}

function renderList() {
  const list = $('clsList');
  const term = norm(filters.text.trim());
  const filtered = !!(term || filters.type || filters.chap);
  const docs = state.classeur.docs.filter((d) =>
    (!filters.type || d.type === filters.type) &&
    (!filters.chap || d.chapId === filters.chap) &&
    (!term || norm(d.nom).includes(term)));
  list.innerHTML = '';
  if (filtered && !docs.length) { list.innerHTML = '<p class="sub">Aucun document ne correspond.</p>'; return; }
  if (!state.classeur.docs.length && !filters.mat) {
    list.insertAdjacentHTML('beforeend', '<div class="panel empty-state"><h2>Ton classeur est vide</h2><p class="sub">Ajoute tes cours, TD et DS en PDF avec « Ajouter un PDF ». Ils sont rangés par chapitre, à côté de tes cartes, et tu peux les surligner et les annoter.</p></div>');
  }
  const byChap = new Map();
  const orphans = [];
  docs.forEach((d) => {
    if (!state.byId.has(d.chapId)) { orphans.push(d); return; }
    if (!byChap.has(d.chapId)) byChap.set(d.chapId, []);
    byChap.get(d.chapId).push(d);
  });
  if (!filtered && !filters.mat) {
    list.insertAdjacentHTML('beforeend', '<p class="sub cls-help">Touche le nom d\'une matière ou d\'un chapitre pour le renommer. Appui long sur un chapitre (ou sur ⠿) pour le déplacer.</p>');
  }
  state.matieres.forEach((m) => {
    if (filters.mat && m.id !== filters.mat) return;
    // Sans filtre, tous les chapitres sont affichés (même vides) pour pouvoir les gérer.
    const chs = filtered ? m.chapitres.filter((c) => byChap.has(c.id)) : m.chapitres;
    if (!chs.length) return;
    const sec = document.createElement('section');
    sec.className = 'matiere';
    sec.dataset.mat = m.id;
    sec.innerHTML = '<div class="matiere-head"><div class="name-slot"></div></div><div class="cls-chaps"></div>';
    sec.querySelector('.name-slot').appendChild(nameButton('h2', m.nom, () => editMatiereName(sec, m)));
    const box = sec.querySelector('.cls-chaps');
    if (!filtered && (m.carnets || []).includes('resumes')) {
      const wrap = document.createElement('ul');
      wrap.className = 'cls-docs cls-mat-carnets';
      const n = countResumes(m.id);
      wrap.appendChild(carnetRow('Résumés des chapitres', n ? plural(n, 'résumé', 'résumés') + ' · un onglet par œuvre' : 'Un onglet par œuvre', () => openResumes(m.id)));
      box.appendChild(wrap);
    }
    chs.forEach((c) => box.appendChild(chapterBox(c, byChap.get(c.id) || [], !filtered)));
    list.appendChild(sec);
  });
  if (orphans.length && !filters.mat) {
    const sec = document.createElement('section');
    sec.className = 'matiere';
    sec.innerHTML = '<div class="matiere-head"><div><h2>Sans chapitre</h2></div></div><div class="cls-chaps"><div class="cls-chap"><p class="sub">Documents dont le chapitre a été supprimé. « Modifier » permet de les ranger ailleurs.</p><ul class="cls-docs"></ul></div></div>';
    const ul = sec.querySelector('ul');
    sortDocs(orphans).forEach((d) => ul.appendChild(docRow(d)));
    list.appendChild(sec);
  }
}

const typeOrder = { cours: 0, td: 1, ds: 2 };
function sortDocs(docs) {
  return docs.slice().sort((a, b) => (typeOrder[a.type] - typeOrder[b.type]) || a.nom.localeCompare(b.nom, 'fr'));
}

// Titre qui se transforme en champ modifiable quand on le touche.
function nameButton(tag, text, onEdit) {
  const el = document.createElement(tag);
  el.className = 'editable-name';
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.title = 'Toucher pour renommer';
  el.textContent = text;
  el.addEventListener('click', (e) => {
    if (dragJustEnded) return;
    e.stopPropagation();
    if (!canEdit()) { toast('Renseigne ton jeton GitHub dans les réglages pour renommer.'); return; }
    onEdit();
  });
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } });
  return el;
}

function chapterBox(c, docs, manageable) {
  const box = document.createElement('div');
  box.className = 'cls-chap';
  box.dataset.ch = c.id;
  box.innerHTML = '<div class="cls-chap-head">' + (manageable ? '<span class="drag-handle" aria-hidden="true">⠿</span>' : '') +
    '<div class="name-slot"></div><span class="cls-count"></span></div><div class="cls-edit-slot"></div><ul class="cls-docs"></ul>';
  box.querySelector('.name-slot').appendChild(nameButton('h3', c.nom, () => editChapterName(box, c, docs)));
  box.querySelector('.cls-count').textContent = plural(c.cartes.length, 'carte', 'cartes');
  const ul = box.querySelector('ul');
  const hasCarnet = c.meta && c.meta.carnet === 'citations' && !filters.type && !filters.text;
  if (hasCarnet) {
    const n = countCitations(c);
    ul.appendChild(carnetRow('Citations', n ? plural(n, 'citation', 'citations') + ' · triées par page' : 'Relevé de citations, trié par page', () => openCitations(c)));
  }
  if (docs.length) sortDocs(docs).forEach((d) => ul.appendChild(docRow(d)));
  else if (!hasCarnet) ul.innerHTML = '<li class="sub cls-empty">Aucun document</li>';
  if (manageable) enableDrag(box);
  return box;
}

// ---------- Renommer ----------
function inlineEditor(slot, value, { onSave, onDelete, label }) {
  slot.innerHTML = '';
  const form = document.createElement('form');
  form.className = 'inline-edit';
  form.innerHTML = '<input type="text" autocomplete="off" aria-label="' + escapeHtml(label) + '">' +
    '<div class="row"><button class="primary small" type="submit">Enregistrer</button><button class="ghost small" type="button" data-act="cancel">Annuler</button>' +
    (onDelete ? '<button class="again small" type="button" data-act="delete">Supprimer le chapitre</button>' : '') + '</div>' +
    '<p class="status" role="status"></p>';
  const input = form.querySelector('input');
  input.value = value;
  const status = form.querySelector('.status');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nom = input.value.trim();
    if (!nom) { status.textContent = 'Le nom ne peut pas être vide.'; status.className = 'status error'; return; }
    if (nom === value) { renderList(); return; }
    form.querySelectorAll('button, input').forEach((x) => { x.disabled = true; });
    status.textContent = 'Enregistrement…';
    status.className = 'status';
    try {
      await onSave(nom);
      toast('Nom modifié.');
      renderList();
    } catch (err) {
      form.querySelectorAll('button, input').forEach((x) => { x.disabled = false; });
      status.textContent = 'Échec : ' + err.message;
      status.className = 'status error';
    }
  });
  form.querySelector('[data-act="cancel"]').addEventListener('click', () => renderList());
  if (onDelete) form.querySelector('[data-act="delete"]').addEventListener('click', onDelete);
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') renderList(); });
  slot.appendChild(form);
  input.focus();
  input.select();
}

function editMatiereName(sec, m) {
  inlineEditor(sec.querySelector('.name-slot'), m.nom, { label: 'Nom de la matière', onSave: (nom) => renameMatiere(m.id, nom) });
}

function editChapterName(box, c, docs) {
  box.querySelector('.cls-chap-head').hidden = true;
  inlineEditor(box.querySelector('.cls-edit-slot'), c.nom, {
    label: 'Nom du chapitre',
    onSave: (nom) => renameChapter(c, nom),
    onDelete: () => confirmDeleteChapter(box, c, docs),
  });
}

// ---------- Supprimer un chapitre ----------
function confirmDeleteChapter(box, c, docs) {
  const slot = box.querySelector('.cls-edit-slot');
  const allDocs = state.classeur.docs.filter((d) => d.chapId === c.id);
  slot.innerHTML = '<div class="confirm-inline danger"><p></p><div class="row">' +
    '<button class="again small" type="button" data-act="yes">Oui, supprimer</button>' +
    '<button class="ghost small" type="button" data-act="no">Annuler</button></div><p class="status" role="status"></p></div>';
  slot.querySelector('p').textContent = 'Supprimer le chapitre « ' + c.nom + ' »' +
    (c.cartes.length ? ' et ses ' + plural(c.cartes.length, 'carte', 'cartes') : '') + ' ? ' +
    (allDocs.length ? (allDocs.length > 1 ? 'Ses ' + allDocs.length + ' documents seront gardés' : 'Son document sera gardé') + ' dans « Sans chapitre ».' : 'Ce chapitre ne contient aucun document.') +
    ' Cette action est définitive.';
  const status = slot.querySelector('.status');
  slot.querySelector('[data-act="no"]').addEventListener('click', () => renderList());
  slot.querySelector('[data-act="yes"]').addEventListener('click', async (e) => {
    slot.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    status.textContent = 'Suppression…';
    try {
      if (allDocs.length) {
        await updateIndex((list) => list.map((d) => (d.chapId === c.id ? { ...d, chapId: null } : d)), 'Classeur : documents de « ' + c.nom + ' » sans chapitre');
      }
      await deleteChapter(c);
      toast('Chapitre supprimé.');
      if (filters.chap === c.id) filters.chap = '';
      renderClasseur();
    } catch (err) {
      slot.querySelectorAll('button').forEach((x) => { x.disabled = false; });
      status.textContent = 'Échec : ' + err.message;
      status.className = 'status error';
    }
  });
}

// ---------- Glisser-déposer pour réordonner ----------
let drag = null;
let dragJustEnded = false;
function enableDrag(box) {
  const head = box.querySelector('.cls-chap-head');
  const handle = box.querySelector('.drag-handle');
  let timer = null, start = null;
  const cancel = () => { clearTimeout(timer); timer = null; start = null; };
  head.addEventListener('pointerdown', (e) => {
    if (!canEdit() || e.button > 0) return;
    const onHandle = e.target === handle;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    if (onHandle) { e.preventDefault(); beginDrag(box, e); return; }
    timer = setTimeout(() => { timer = null; beginDrag(box, e); }, 450); // appui long
  });
  head.addEventListener('pointermove', (e) => {
    if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) cancel(); // c'est un défilement
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => head.addEventListener(t, () => { if (timer) cancel(); }));
  head.addEventListener('contextmenu', (e) => e.preventDefault());
}

function beginDrag(box, e) {
  const sec = box.closest('.matiere');
  drag = { box, sec, id: e.pointerId, before: [...sec.querySelectorAll('.cls-chap')].map((b) => b.dataset.ch) };
  box.classList.add('dragging');
  sec.classList.add('sorting');
  if (navigator.vibrate) { try { navigator.vibrate(15); } catch (err) { /* non disponible */ } }
}
function onDragMove(e) {
  if (!drag) return;
  e.preventDefault();
  const y = e.clientY;
  if (y < 90) window.scrollBy(0, -12); else if (y > window.innerHeight - 90) window.scrollBy(0, 12);
  const siblings = [...drag.sec.querySelectorAll('.cls-chap')].filter((b) => b !== drag.box);
  const after = siblings.find((b) => { const r = b.getBoundingClientRect(); return y < r.top + r.height / 2; });
  const parent = drag.box.parentNode;
  if (after) { if (after !== drag.box.nextSibling) parent.insertBefore(drag.box, after); }
  else if (parent.lastChild !== drag.box) parent.appendChild(drag.box);
}
async function onDragEnd() {
  if (!drag) return;
  const { box, sec, before } = drag;
  drag = null;
  dragJustEnded = true;
  setTimeout(() => { dragJustEnded = false; }, 300);
  box.classList.remove('dragging');
  sec.classList.remove('sorting');
  const after = [...sec.querySelectorAll('.cls-chap')].map((b) => b.dataset.ch);
  if (after.join() === before.join()) return;
  try {
    await reorderChapters(sec.dataset.mat, after);
    toast('Ordre enregistré.');
  } catch (err) {
    toast('Échec du déplacement : ' + err.message);
    renderList();
  }
}
document.addEventListener('pointermove', onDragMove, { passive: false });
document.addEventListener('pointerup', onDragEnd);
document.addEventListener('pointercancel', onDragEnd);
// Empêche la page de défiler pendant le déplacement d'un chapitre (iPhone).
document.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });

function renderMatChips() {
  const box = $('clsMats');
  if (filters.mat && !state.matieres.some((m) => m.id === filters.mat)) filters.mat = '';
  box.innerHTML = '';
  [['', 'Toutes'], ...state.matieres.map((m) => [m.id, m.nom])].forEach(([id, nom]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = nom;
    b.className = id === filters.mat ? 'on' : '';
    b.setAttribute('aria-pressed', String(id === filters.mat));
    b.addEventListener('click', () => {
      filters.mat = id;
      writeMat(id);
      if (filters.chap && id && (state.byId.get(filters.chap) || {}).matiere !== id) filters.chap = '';
      renderMatChips();
      renderList();
      window.scrollTo(0, 0);
    });
    box.appendChild(b);
  });
}

function docRow(d) {
  const li = document.createElement('li');
  li.className = 'cls-doc';
  li.innerHTML =
    '<button class="cls-open" type="button"><span class="badge t-' + d.type + '">' + escapeHtml(DOC_TYPES[d.type] || d.type) + '</span>' +
    '<span class="cls-name"></span><span class="cls-meta">' + fmtDate(d.added) + ' · ' + fmtSize(d.size || 0) + '</span></button>' +
    '<button class="ghost small cls-edit" type="button" aria-label="Modifier « ' + escapeHtml(d.nom) + ' »">Modifier</button>';
  li.querySelector('.cls-name').textContent = d.nom;
  li.querySelector('.cls-open').addEventListener('click', () => openDoc(d));
  li.querySelector('.cls-edit').addEventListener('click', () => openDocForm(d));
  return li;
}

export async function openDoc(d) {
  try {
    toast('Ouverture de « ' + d.nom + ' »…');
    const buf = await getPdf(d);
    openViewer(d, buf);
  } catch (e) {
    toast('Impossible d\'ouvrir le document : ' + e.message);
  }
}

// Ouvre le classeur filtré sur un chapitre (depuis l'accueil).
export function showChapterDocs(chId) {
  const ch = state.byId.get(chId);
  Object.assign(filters, { text: '', type: '', chap: chId, mat: ch ? ch.matiere : '' });
  if (location.hash.slice(1) !== 'classeur') location.hash = 'classeur';
  else route();
}

// =====================================================================
// Formulaire d'ajout / de modification
// =====================================================================
function fillMat(selMat) {
  $('dfMat').innerHTML = state.matieres.map((m) => '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.nom) + '</option>').join('');
  if (selMat) $('dfMat').value = selMat;
}
function fillChap(selChap) {
  const mat = $('dfMat').value;
  const chs = state.chapters.filter((c) => c.matiere === mat);
  $('dfChap').innerHTML = chs.map((c) => '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.nom) + '</option>').join('') +
    '<option value="__new">+ Nouveau chapitre…</option>';
  $('dfChap').value = selChap && chs.some((c) => c.id === selChap) ? selChap : chs[0] ? chs[0].id : '__new';
  $('dfNewChapBox').hidden = $('dfChap').value !== '__new';
}

function openDocForm(doc) {
  editing = doc || null;
  pickedFile = null;
  $('dfTitle').textContent = doc ? 'Modifier le document' : 'Ajouter un document';
  $('dfFileBox').hidden = !!doc;
  $('dfFileName').textContent = 'Aucun fichier choisi';
  $('dfNom').value = doc ? doc.nom : '';
  $('dfType').value = doc ? doc.type : 'cours';
  const ch = doc ? state.byId.get(doc.chapId) : state.byId.get(filters.chap);
  fillMat(ch ? ch.matiere : doc ? doc.matiere : '');
  fillChap(ch ? ch.id : '');
  $('dfNewChap').value = '';
  $('dfDelete').hidden = !doc;
  $('dfCards').hidden = !doc || !state.config.geminiKey;
  $('dfDeleteConfirm').hidden = true;
  setStatus('dfStatus', '');
  showView('docform');
}

function pickFile(input) {
  const f = input.files && input.files[0];
  input.value = '';
  if (!f) return;
  if (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) { setStatus('dfStatus', 'Choisis un fichier PDF.', 'error'); return; }
  if (f.size > MAX_MB * 1048576) { setStatus('dfStatus', 'Ce PDF dépasse ' + MAX_MB + ' Mo : découpe-le en plusieurs parties.', 'error'); return; }
  pickedFile = f;
  $('dfFileName').textContent = f.name + ' · ' + fmtSize(f.size);
  if (!$('dfNom').value.trim()) $('dfNom').value = f.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim();
  setStatus('dfStatus', '');
}

async function chosenChapter() {
  if ($('dfChap').value !== '__new') return state.byId.get($('dfChap').value);
  const nom = $('dfNewChap').value.trim();
  if (!nom) throw new Error('Donne un nom au nouveau chapitre.');
  return createChapterFile($('dfMat').value, nom);
}

async function saveDoc() {
  const nom = $('dfNom').value.trim();
  if (!editing && !pickedFile) { setStatus('dfStatus', 'Choisis un PDF.', 'error'); return; }
  if (!nom) { setStatus('dfStatus', 'Donne un nom au document.', 'error'); return; }
  $('dfSave').disabled = true;
  try {
    setStatus('dfStatus', editing ? 'Enregistrement…' : 'Envoi du PDF sur GitHub…');
    const ch = await chosenChapter();
    if (editing) {
      const id = editing.id;
      await updateIndex((docs) => docs.map((d) => (d.id === id ? { ...d, nom, type: $('dfType').value, chapId: ch.id, matiere: ch.matiere } : d)),
        'Classeur : modifie « ' + nom + ' »');
      toast('Document enregistré.');
    } else {
      const base64 = await fileToBase64(pickedFile);
      await addDocument({ base64, size: pickedFile.size, nom, type: $('dfType').value, chapId: ch.id, matiere: ch.matiere });
      toast('Document ajouté au classeur.');
    }
    editing = null;
    pickedFile = null;
    route();
  } catch (e) {
    setStatus('dfStatus', 'Échec : ' + e.message, 'error');
  } finally {
    $('dfSave').disabled = false;
  }
}

async function deleteDoc() {
  const doc = editing;
  if (!doc) return;
  $('dfDeleteYes').disabled = true;
  setStatus('dfStatus', 'Suppression…');
  try {
    await updateIndex((docs) => docs.filter((d) => d.id !== doc.id), 'Classeur : retire « ' + doc.nom + ' »');
    const { gh, config } = state;
    try { await gh.deleteFile(config.dataRepo, doc.file, doc.sha, 'Classeur : supprime « ' + doc.nom + ' »'); } catch (e) { /* fichier déjà supprimé */ }
    try {
      const notes = await gh.getFile(config.dataRepo, 'classeur/notes/' + doc.id + '.json');
      if (notes) await gh.deleteFile(config.dataRepo, 'classeur/notes/' + doc.id + '.json', notes.sha, 'Classeur : supprime les annotations de « ' + doc.nom + ' »');
    } catch (e) { /* pas d'annotations */ }
    pdfCache.delete(doc.id);
    toast('Document supprimé.');
    editing = null;
    route();
  } catch (e) {
    setStatus('dfStatus', 'Échec de la suppression : ' + e.message, 'error');
  } finally {
    $('dfDeleteYes').disabled = false;
  }
}

export async function generateFromDoc(doc) {
  try {
    toast('Préparation de « ' + doc.nom + ' »…');
    const buf = await getPdf(doc);
    openImportWithDoc(doc, new File([buf], doc.nom + '.pdf', { type: 'application/pdf' }));
  } catch (e) {
    toast('Impossible de lire le document : ' + e.message);
  }
}

export function bindClasseur() {
  $('clsAdd').addEventListener('click', () => openDocForm(null));
  let t;
  $('clsSearch').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { filters.text = $('clsSearch').value; renderList(); }, 200);
  });
  document.querySelectorAll('#clsTypes button').forEach((b) => b.addEventListener('click', () => {
    filters.type = b.dataset.type;
    document.querySelectorAll('#clsTypes button').forEach((x) => x.classList.toggle('on', x === b));
    renderList();
  }));
  $('clsChapClear').addEventListener('click', () => { filters.chap = ''; renderClasseur(); });
  $('dfBack').addEventListener('click', () => { editing = null; route(); });
  $('dfFile').addEventListener('change', (e) => pickFile(e.target));
  $('dfMat').addEventListener('change', () => fillChap(''));
  $('dfChap').addEventListener('change', () => { $('dfNewChapBox').hidden = $('dfChap').value !== '__new'; });
  $('dfSave').addEventListener('click', saveDoc);
  $('dfDelete').addEventListener('click', () => { $('dfDeleteConfirm').hidden = false; });
  $('dfDeleteNo').addEventListener('click', () => { $('dfDeleteConfirm').hidden = true; });
  $('dfDeleteYes').addEventListener('click', deleteDoc);
  $('dfCards').addEventListener('click', () => { const d = editing; editing = null; generateFromDoc(d); });
}

