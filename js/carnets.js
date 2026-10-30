// Carnets de français : relevé de citations (un carnet par œuvre, trié par page)
// et résumés des chapitres (un carnet par matière, un onglet par œuvre).
// Stockés dans le dépôt privé : carnets/<id>.json, fusionnés entre appareils.
import { isConflict } from './github.js?v=20261030233452';
import { $, state, escapeHtml, toast, plural, canSync, newId, showView, route } from './ui.js?v=20261030233452';

const stores = new Map(); // id du carnet -> { data: { items, deleted }, sha, dirty, loaded }
let open = null;          // { kind: 'citations' | 'resumes', id, chap?, mat?, tab? }
let entry = null;         // élément en cours de saisie
let highlightId = null;
const expanded = new Set(); // éléments dépliés dans la liste

// =====================================================================
// Données
// =====================================================================
const pathOf = (id) => 'carnets/' + id + '.json';
const lsKey = (id) => 'fc.carnet.' + id;

function merge(a, b) {
  const deleted = [...new Set([...(a.deleted || []), ...(b.deleted || [])])];
  const gone = new Set(deleted);
  const map = new Map();
  [...(a.items || []), ...(b.items || [])].forEach((it) => {
    const prev = map.get(it.id);
    if (!prev || (it.t || 0) > (prev.t || 0)) map.set(it.id, it);
  });
  return { items: [...map.values()].filter((it) => !gone.has(it.id)), deleted };
}

function store(id) {
  if (!stores.has(id)) {
    let local = null;
    try { local = JSON.parse(localStorage.getItem(lsKey(id))); } catch (e) { /* rien */ }
    stores.set(id, { data: (local && local.data) || { items: [], deleted: [] }, sha: null, dirty: !!(local && local.dirty), loaded: false });
  }
  return stores.get(id);
}
function saveLocal(id) {
  const st = store(id);
  try { localStorage.setItem(lsKey(id), JSON.stringify({ data: st.data, dirty: st.dirty })); } catch (e) { /* plein */ }
}

export async function loadCarnet(id) {
  const st = store(id);
  if (!canSync()) return st;
  try {
    const f = await state.gh.getFile(state.config.dataRepo, pathOf(id));
    if (f) { st.data = merge(JSON.parse(f.text), st.data); st.sha = f.sha; }
    st.loaded = true;
    saveLocal(id);
    if (st.dirty) schedule(id, 300);
  } catch (e) { console.warn('Carnet non lu', e); }
  return st;
}

const timers = new Map();
function changed(id) {
  const st = store(id);
  st.dirty = true;
  saveLocal(id);
  schedule(id, 1200);
}
function schedule(id, delay) {
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => push(id), delay));
}
export function flushCarnets() {
  timers.forEach((t, id) => { clearTimeout(t); push(id); });
  timers.clear();
}
async function push(id) {
  timers.delete(id);
  const st = store(id);
  if (!st.dirty || !canSync()) return;
  const { gh, config } = state;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      st.sha = await gh.putFile(config.dataRepo, pathOf(id), JSON.stringify({ version: 1, ...st.data }, null, 1) + '\n', st.sha, 'Carnet : mise à jour');
      st.dirty = false;
      saveLocal(id);
      return;
    } catch (e) {
      if (!isConflict(e) && e.status !== 422) { console.warn('Carnet non enregistré', e); return; }
      const f = await gh.getFile(config.dataRepo, pathOf(id)).catch(() => null);
      if (f) { st.data = merge(JSON.parse(f.text), st.data); st.sha = f.sha; } else st.sha = null;
    }
  }
}

function upsert(id, item) {
  const st = store(id);
  item.t = Date.now();
  const i = st.data.items.findIndex((x) => x.id === item.id);
  if (i >= 0) st.data.items[i] = item; else st.data.items.push(item);
  changed(id);
}
function removeItem(id, itemId) {
  const st = store(id);
  st.data.items = st.data.items.filter((x) => x.id !== itemId);
  st.data.deleted.push(itemId);
  changed(id);
}

// Tri par page : « 42 », « 42-43 », « p. 12 », « 595a »… on compare le premier nombre, puis le reste.
function pageKey(p) {
  const m = String(p || '').match(/\d+/);
  return m ? Number(m[0]) : Infinity;
}
function byPage(a, b) {
  return (pageKey(a.page) - pageKey(b.page)) || String(a.page).localeCompare(String(b.page), 'fr', { numeric: true }) || (a.created || 0) - (b.created || 0);
}
function byNum(a, b) {
  return String(a.num || '').localeCompare(String(b.num || ''), 'fr', { numeric: true }) || (a.created || 0) - (b.created || 0);
}

// Œuvres d'une matière : chapitres dotés d'un carnet de citations.
export function oeuvresOf(matId) {
  const m = state.matieres.find((x) => x.id === matId);
  return m ? m.chapitres.filter((c) => c.meta && c.meta.carnet === 'citations') : [];
}
export const citationsId = (ch) => 'citations-' + ch.id;
export const resumesId = (matId) => 'resumes-' + matId;
export function countCitations(ch) { return store(citationsId(ch)).data.items.length; }
export function countResumes(matId) { return store(resumesId(matId)).data.items.length; }

// =====================================================================
// Ouverture d'un carnet
// =====================================================================
export async function openCitations(ch) {
  open = { kind: 'citations', id: citationsId(ch), chap: ch };
  renderCarnet();
  showView('carnet');
  await loadCarnet(open.id);
  if (open && open.id === citationsId(ch)) renderCarnet();
}

export async function openResumes(matId, chapId) {
  const oeuvres = oeuvresOf(matId);
  open = { kind: 'resumes', id: resumesId(matId), mat: matId, tab: chapId || (oeuvres[0] && oeuvres[0].id) };
  renderCarnet();
  showView('carnet');
  await loadCarnet(open.id);
  if (open && open.id === resumesId(matId)) renderCarnet();
}

function oeuvreLabel(ch) {
  const o = (ch && ch.meta && ch.meta.oeuvre) || {};
  return o.titre ? o.auteur + ', ' + o.titre : ch ? ch.nom : '';
}

function renderCarnet() {
  if (!open) return;
  const st = store(open.id);
  const list = $('cnList');
  list.innerHTML = '';
  $('cnTabs').hidden = open.kind !== 'resumes';
  $('cnGoto').hidden = open.kind !== 'citations';
  if (open.kind === 'citations') {
    const items = st.data.items.slice().sort(byPage);
    $('cnTitle').textContent = 'Citations';
    $('cnSub').textContent = oeuvreLabel(open.chap);
    $('cnCount').textContent = plural(items.length, 'citation', 'citations');
    $('cnAdd').textContent = '+ Nouvelle citation';
    if (!items.length) list.innerHTML = '<li class="cn-empty">Aucune citation pour l\'instant. Ajoute la première avec le bouton en bas : elles se rangeront toutes seules par numéro de page.</li>';
    items.forEach((it) => list.appendChild(citationRow(it)));
  } else {
    const oeuvres = oeuvresOf(open.mat);
    if (!oeuvres.some((c) => c.id === open.tab)) open.tab = oeuvres[0] && oeuvres[0].id;
    const tabs = $('cnTabs');
    tabs.innerHTML = '';
    oeuvres.forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = (c.meta.oeuvre && c.meta.oeuvre.court) || c.nom;
      b.className = c.id === open.tab ? 'on' : '';
      b.setAttribute('aria-pressed', String(c.id === open.tab));
      b.addEventListener('click', () => { open.tab = c.id; renderCarnet(); });
      tabs.appendChild(b);
    });
    const ch = state.byId.get(open.tab);
    const items = st.data.items.filter((it) => it.oeuvre === open.tab).sort(byNum);
    $('cnTitle').textContent = 'Résumés des chapitres';
    $('cnSub').textContent = oeuvreLabel(ch);
    $('cnCount').textContent = plural(items.length, 'résumé', 'résumés');
    $('cnAdd').textContent = '+ Nouveau résumé';
    if (!oeuvres.length) list.innerHTML = '<li class="cn-empty">Aucune œuvre dans cette matière.</li>';
    else if (!items.length) list.innerHTML = '<li class="cn-empty">Aucun résumé pour cette œuvre. Ajoute le premier chapitre avec le bouton en bas.</li>';
    items.forEach((it) => list.appendChild(resumeRow(it)));
  }
  requestAnimationFrame(() => markTruncated(list));
  if (highlightId) {
    const el = list.querySelector('[data-id="' + highlightId + '"]');
    highlightId = null;
    if (el) {
      el.classList.add('flash');
      requestAnimationFrame(() => el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
    }
  }
}

function citationRow(it) {
  const li = document.createElement('li');
  li.className = 'cn-item';
  li.dataset.id = it.id;
  li.innerHTML = '<button type="button" class="cn-card">' +
    '<span class="cn-page"></span>' +
    '<span class="cn-main"><span class="cn-quote"></span>' +
    '<span class="cn-field"><b>Contexte</b><span class="cn-ctx"></span></span>' +
    '<span class="cn-field"><b>Pourquoi</b><span class="cn-why"></span></span>' +
    '<span class="cn-more" aria-hidden="true">Contexte et justification</span></span></button>';
  li.querySelector('.cn-page').textContent = 'p. ' + it.page;
  li.querySelector('.cn-quote').textContent = '« ' + it.texte + ' »';
  li.querySelector('.cn-ctx').textContent = it.contexte || '—';
  li.querySelector('.cn-why').textContent = it.justification || '—';
  li.classList.add('cit');
  li.dataset.page = pageKey(it.page);
  // Repliée : seulement la page et la citation ; le contexte et la justification au toucher.
  li.dataset.details = (it.contexte || it.justification) ? '1' : '';
  return foldable(li, it);
}

function resumeRow(it) {
  const li = document.createElement('li');
  li.className = 'cn-item';
  li.dataset.id = it.id;
  li.innerHTML = '<button type="button" class="cn-card resume">' +
    '<span class="cn-res-head"><span class="cn-num"></span><span class="cn-res-title"></span><span class="cn-res-pages"></span></span>' +
    '<span class="cn-res-text cn-clamp"></span><span class="cn-more" aria-hidden="true">Lire la suite</span></button>';
  li.querySelector('.cn-num').textContent = it.num ? 'Ch. ' + it.num : 'Ch. ?';
  li.querySelector('.cn-res-title').textContent = it.titre || '';
  li.querySelector('.cn-res-pages').textContent = it.pages ? 'p. ' + it.pages : '';
  li.querySelector('.cn-res-text').textContent = it.texte;
  return foldable(li, it);
}

// Un toucher déplie l'élément en entier (lecture seule), un autre le replie.
// Le bouton « Modifier » n'apparaît que sur un élément déplié.
function foldable(li, it) {
  const card = li.querySelector('.cn-card');
  const bar = document.createElement('div');
  bar.className = 'cn-actions';
  bar.innerHTML = '<button type="button" class="ghost small">Modifier</button>';
  bar.querySelector('button').addEventListener('click', () => openEntry(it));
  li.appendChild(bar);
  const set = (on) => {
    li.classList.toggle('open', on);
    card.setAttribute('aria-expanded', String(on));
    bar.hidden = !on;
    if (!on) requestAnimationFrame(() => markCut(li));
  };
  set(expanded.has(it.id));
  card.addEventListener('click', () => {
    const on = !expanded.has(it.id);
    if (on) expanded.add(it.id); else expanded.delete(it.id);
    set(on);
  });
  return li;
}

// Après affichage : signale les éléments repliés dont le texte est coupé.
function markCut(li) {
  if (li.classList.contains('open')) return; // déplié : rien n'est coupé, on garde l'état précédent
  if (li.classList.contains('cit')) { li.classList.toggle('cut', !!li.dataset.details); return; }
  li.classList.toggle('cut', [...li.querySelectorAll('.cn-clamp')].some((el) => el.scrollHeight > el.clientHeight + 1));
}
function markTruncated(list) { list.querySelectorAll('.cn-item').forEach(markCut); }

// =====================================================================
// Saisie d'une citation ou d'un résumé
// =====================================================================
function openEntry(it) {
  const isNew = !it;
  const kind = open.kind;
  entry = it ? { ...it } : kind === 'citations'
    ? { id: newId(), page: '', texte: '', contexte: '', justification: '', created: Date.now() }
    : { id: newId(), oeuvre: open.tab, num: nextNum(), titre: '', pages: '', texte: '', created: Date.now() };
  entry._new = isNew;
  $('enTitle').textContent = isNew ? (kind === 'citations' ? 'Nouvelle citation' : 'Nouveau résumé') : (kind === 'citations' ? 'Citation' : 'Résumé');
  $('enCitation').hidden = kind !== 'citations';
  $('enResume').hidden = kind !== 'resumes';
  $('enSaveNext').hidden = !isNew;
  $('enDelete').hidden = isNew;
  $('enDeleteConfirm').hidden = true;
  $('enStatus').textContent = '';
  if (kind === 'citations') {
    $('enPage').value = entry.page;
    $('enTexte').value = entry.texte;
    $('enContexte').value = entry.contexte;
    $('enJustif').value = entry.justification;
  } else {
    const ch = state.byId.get(entry.oeuvre);
    $('enOeuvre').textContent = oeuvreLabel(ch);
    $('enNum').value = entry.num;
    $('enChTitre').value = entry.titre;
    $('enPages').value = entry.pages;
    $('enResTexte').value = entry.texte;
  }
  showView('entree');
  setTimeout(() => (kind === 'citations' ? $('enPage') : $('enNum')).focus(), 60);
}

// Numéro proposé pour le prochain résumé : le chapitre suivant le plus grand déjà saisi.
function nextNum() {
  const items = store(open.id).data.items.filter((it) => it.oeuvre === open.tab);
  const nums = items.map((it) => parseInt(it.num, 10)).filter((n) => Number.isFinite(n));
  return nums.length ? String(Math.max(...nums) + 1) : '1';
}

function readEntry() {
  if (open.kind === 'citations') {
    Object.assign(entry, {
      page: $('enPage').value.trim(), texte: $('enTexte').value.trim().replace(/^[«"“]\s*|\s*[»"”]$/g, ''),
      contexte: $('enContexte').value.trim(), justification: $('enJustif').value.trim(),
    });
    if (!entry.page) return 'Indique le numéro de page.';
    if (!entry.texte) return 'Écris la citation.';
  } else {
    Object.assign(entry, {
      num: $('enNum').value.trim(), titre: $('enChTitre').value.trim(),
      pages: $('enPages').value.trim(), texte: $('enResTexte').value.trim(),
    });
    if (!entry.num) return 'Indique le numéro du chapitre.';
    if (!entry.texte) return 'Écris le résumé.';
  }
  return null;
}

function saveEntry(next) {
  const err = readEntry();
  if (err) { $('enStatus').textContent = err; $('enStatus').className = 'status error'; return; }
  const { _new, ...item } = entry;
  upsert(open.id, item);
  if (next) {
    toast(open.kind === 'citations' ? 'Citation ajoutée, page ' + item.page + '.' : 'Résumé ajouté.');
    openEntry(null);
    return;
  }
  highlightId = item.id;
  entry = null;
  backToCarnet();
}

function backToCarnet() {
  entry = null;
  renderCarnet();
  showView('carnet');
}

// =====================================================================
// Événements
// =====================================================================
// « Aller à la page » : fait défiler jusqu'à la première citation à partir de cette page.
function gotoPage() {
  const n = parseInt($('cnPage').value, 10);
  if (!Number.isFinite(n)) return;
  const items = [...$('cnList').querySelectorAll('.cn-item.cit')];
  if (!items.length) return;
  const el = items.find((li) => Number(li.dataset.page) >= n) || items[items.length - 1];
  $('cnPage').blur();
  $('cnList').querySelectorAll('.flash').forEach((x) => x.classList.remove('flash'));
  void el.offsetWidth;
  el.classList.add('flash');
  el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

export function bindCarnets() {
  $('cnGoto').addEventListener('submit', (e) => { e.preventDefault(); gotoPage(); });
  $('cnBack').addEventListener('click', () => { open = null; flushCarnets(); route(); });
  $('cnAdd').addEventListener('click', () => openEntry(null));
  $('enBack').addEventListener('click', backToCarnet);
  $('enSave').addEventListener('click', () => saveEntry(false));
  $('enSaveNext').addEventListener('click', () => saveEntry(true));
  $('enDelete').addEventListener('click', () => { $('enDeleteConfirm').hidden = false; });
  $('enDeleteNo').addEventListener('click', () => { $('enDeleteConfirm').hidden = true; });
  $('enDeleteYes').addEventListener('click', () => {
    removeItem(open.id, entry.id);
    toast(open.kind === 'citations' ? 'Citation supprimée.' : 'Résumé supprimé.');
    backToCarnet();
  });
  // Entrée dans le champ page passe à la citation.
  $('enPage').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('enTexte').focus(); } });
  $('enNum').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('enChTitre').focus(); } });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushCarnets(); });
}
