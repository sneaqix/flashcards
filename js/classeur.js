// Onglet Classeur : documents PDF (cours, TD, DS) rangés par matière et chapitre,
// stockés dans le dépôt privé de sauvegarde.
import { isConflict } from './github.js?v=20261030092917';
import { fileToBase64 } from './gemini.js?v=20261030092917';
import { $, state, escapeHtml, toast, setStatus, plural, canSync, canEdit, newId, showView, route } from './ui.js?v=20261030092917';
import { createChapterFile } from './sync.js?v=20261030092917';
import { openViewer } from './viewer.js?v=20261030092917';
import { openImportWithDoc } from './importer.js?v=20261030092917';

export const DOC_TYPES = { cours: 'Cours', td: 'TD / exercices', ds: 'DS / colles' };
const INDEX = 'classeur/index.json';
const MAX_MB = 25;

const filters = { text: '', type: '', chap: '' };
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
}

function renderList() {
  const list = $('clsList');
  const term = norm(filters.text.trim());
  const docs = state.classeur.docs.filter((d) =>
    (!filters.type || d.type === filters.type) &&
    (!filters.chap || d.chapId === filters.chap) &&
    (!term || norm(d.nom).includes(term)));
  list.innerHTML = '';
  if (!state.classeur.docs.length) {
    list.innerHTML = '<div class="panel empty-state"><h2>Ton classeur est vide</h2><p class="sub">Ajoute tes cours, TD et DS en PDF. Ils sont rangés par chapitre, à côté de tes cartes, et tu peux les surligner et les annoter.</p></div>';
    return;
  }
  if (!docs.length) { list.innerHTML = '<p class="sub">Aucun document ne correspond.</p>'; return; }
  // Regroupement matière → chapitre, dans l'ordre des matières et chapitres de l'appli.
  const orphans = [];
  const byChap = new Map();
  docs.forEach((d) => {
    if (!state.byId.has(d.chapId)) { orphans.push(d); return; }
    if (!byChap.has(d.chapId)) byChap.set(d.chapId, []);
    byChap.get(d.chapId).push(d);
  });
  const groups = [];
  state.matieres.forEach((m) => {
    const chs = m.chapitres.filter((c) => byChap.has(c.id));
    if (chs.length) groups.push({ nom: m.nom, chs: chs.map((c) => ({ nom: c.nom, docs: byChap.get(c.id) })) });
  });
  if (orphans.length) groups.push({ nom: 'Sans chapitre', chs: [{ nom: 'Chapitre supprimé ou introuvable', docs: orphans }] });
  const typeOrder = { cours: 0, td: 1, ds: 2 };
  groups.forEach((g) => {
    const sec = document.createElement('section');
    sec.className = 'matiere';
    sec.innerHTML = '<div class="matiere-head"><div><h2></h2></div></div>';
    sec.querySelector('h2').textContent = g.nom;
    g.chs.forEach((c) => {
      const box = document.createElement('div');
      box.className = 'cls-chap';
      box.innerHTML = '<h3></h3><ul class="cls-docs"></ul>';
      box.querySelector('h3').textContent = c.nom;
      const ul = box.querySelector('ul');
      c.docs.sort((a, b) => (typeOrder[a.type] - typeOrder[b.type]) || a.nom.localeCompare(b.nom, 'fr'))
        .forEach((d) => ul.appendChild(docRow(d)));
      sec.appendChild(box);
    });
    list.appendChild(sec);
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
  Object.assign(filters, { text: '', type: '', chap: chId });
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

