// Lecteur PDF du classeur (PDF.js) avec surlignage, notes et dessin à main levée.
// Les annotations sont enregistrées dans le dépôt privé : classeur/notes/<id>.json.
import { isConflict } from './github.js?v=20261030122825';
import { $, state, escapeHtml, toast, newId, showView, route, canEdit, canSync } from './ui.js?v=20261030122825';
import { openEditor } from './editor.js?v=20261030122825';
import { generateFromDoc } from './classeur.js?v=20261030122825';

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
export const COLORS = { jaune: '#ffd60a', vert: '#34c759', bleu: '#3fa7ff', rose: '#ff6fb1' };
const COLOR_NAMES = { jaune: 'jaune', vert: 'vert', bleu: 'bleu', rose: 'rose' };
const ZOOMS = [1, 1.25, 1.5, 2, 3];
const W = 1000; // largeur d'une page en unités d'annotation (la hauteur suit les proportions de la page)
const HINTS = {
  lire: 'Sélectionne du texte (appui long) pour le surligner. Touche un surlignage pour le modifier.',
  note: 'Touche la page là où placer une note.',
  dessin: 'Dessine au doigt ou au stylet. Repasse en « Lire » pour faire défiler.',
  gomme: 'Touche un surlignage, une note ou un trait pour l\'effacer.',
};

let cur = null;   // { doc, pdf, pages, zoom, gen, ann, annSha }
let mode = 'lire';
let color = 'jaune';
let lastRange = null;
let observer = null;
let savedScroll = 0;

// =====================================================================
// Chargement
// =====================================================================
// Deux sources possibles pour PDF.js : si la première ne répond pas, on essaie la seconde.
const PDFJS_SOURCES = [
  [PDFJS + 'pdf.min.js', PDFJS + 'pdf.worker.min.js'],
  ['https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js', 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js'],
];
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error('échec')); };
    document.head.appendChild(s);
  });
}
async function loadLib() {
  if (window.pdfjsLib) return window.pdfjsLib;
  for (const [lib, worker] of PDFJS_SOURCES) {
    try {
      await loadScript(lib);
      if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = worker;
        return window.pdfjsLib;
      }
    } catch (e) { /* source suivante */ }
  }
  throw new Error('le lecteur PDF n\'a pas pu être chargé. Vérifie ta connexion.');
}

export async function openViewer(doc, buf) {
  closeViewer(false);
  showView('lecteur');
  $('lecTitle').textContent = doc.nom;
  $('lecPage').textContent = '';
  $('lecPages').innerHTML = '';
  $('lecStatus').textContent = 'Chargement du document…';
  $('lecCards').hidden = !state.config.geminiKey;
  setMode('lire');
  const session = { doc, pages: [], zoom: 1, gen: 0, ann: emptyAnn(), annSha: null, pdf: null };
  cur = session;
  try {
    const lib = await loadLib();
    const pdf = await lib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
    if (cur !== session) { pdf.destroy(); return; }
    session.pdf = pdf;
    for (let n = 1; n <= pdf.numPages; n++) {
      const proxy = await pdf.getPage(n);
      const vp = proxy.getViewport({ scale: 1 });
      session.pages.push({ n, proxy, w: vp.width, h: vp.height, H: W * vp.height / vp.width });
    }
    session.ann = await loadAnnotations(doc);
    if (cur !== session) return;
    $('lecStatus').textContent = '';
    layout();
    const last = readLastPage(doc.id);
    if (last > 1) scrollToPage(last);
  } catch (e) {
    if (cur === session) $('lecStatus').textContent = 'Impossible d\'afficher ce PDF : ' + e.message;
  }
}

function closeViewer(navigate = true) {
  if (cur) {
    flushSave();
    if (observer) observer.disconnect();
    try { if (cur.pdf) cur.pdf.destroy(); } catch (e) { /* déjà fermé */ }
    cur = null;
  }
  hideSelBar();
  closeSheet();
  if (navigate) route();
}

// =====================================================================
// Mise en page et rendu des pages
// =====================================================================
function layout() {
  const box = $('lecPages');
  const keep = currentPage();
  box.innerHTML = '';
  if (observer) observer.disconnect();
  cur.gen++;
  const base = Math.min($('lecScroll').clientWidth, 900);
  observer = new IntersectionObserver(onIntersect, { rootMargin: '900px 0px' });
  cur.pages.forEach((pg) => {
    pg.cssW = Math.floor(base * cur.zoom);
    pg.cssH = Math.floor(pg.cssW * pg.h / pg.w);
    pg.rendered = false;
    const el = document.createElement('div');
    el.className = 'pg';
    el.dataset.n = pg.n;
    el.style.width = pg.cssW + 'px';
    el.style.height = pg.cssH + 'px';
    el.innerHTML =
      '<canvas class="pg-canvas"></canvas>' +
      '<svg class="pg-hl" viewBox="0 0 ' + W + ' ' + pg.H + '" preserveAspectRatio="none" aria-hidden="true"></svg>' +
      '<div class="textLayer"></div>' +
      '<svg class="pg-ink" viewBox="0 0 ' + W + ' ' + pg.H + '" preserveAspectRatio="none" aria-hidden="true"></svg>' +
      '<div class="pg-notes"></div>' +
      '<span class="pg-num">' + pg.n + '</span>';
    pg.el = el;
    box.appendChild(el);
    drawAnnotations(pg);
    observer.observe(el);
  });
  $('lecZoom').textContent = Math.round(cur.zoom * 100) + ' %';
  if (keep > 1) scrollToPage(keep);
  updatePageIndicator();
}

function onIntersect(entries) {
  entries.forEach((en) => {
    const pg = cur && cur.pages[Number(en.target.dataset.n) - 1];
    if (!pg) return;
    if (en.isIntersecting) renderPage(pg);
    else releasePage(pg); // libère la mémoire des pages éloignées (important sur iPhone)
  });
}

async function renderPage(pg) {
  if (pg.rendered || pg.rendering) return;
  pg.rendering = true;
  const gen = cur.gen;
  const lib = window.pdfjsLib;
  try {
    const scale = pg.cssW / pg.w;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (pg.cssW * pg.cssH * dpr * dpr > 12e6) dpr = Math.sqrt(12e6 / (pg.cssW * pg.cssH));
    const canvas = pg.el.querySelector('canvas');
    const vp = pg.proxy.getViewport({ scale: scale * dpr });
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    pg.task = pg.proxy.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
    await pg.task.promise;
    if (!cur || gen !== cur.gen) return;
    const tl = pg.el.querySelector('.textLayer');
    tl.innerHTML = '';
    tl.style.setProperty('--scale-factor', scale);
    const text = await pg.proxy.getTextContent();
    if (!cur || gen !== cur.gen) return;
    await lib.renderTextLayer({ textContentSource: text, container: tl, viewport: pg.proxy.getViewport({ scale }), textDivs: [] }).promise;
    pg.rendered = true;
  } catch (e) {
    if (e && e.name !== 'RenderingCancelledException') console.warn('Rendu de la page ' + pg.n, e);
  } finally {
    pg.rendering = false;
  }
}

function releasePage(pg) {
  if (pg.task) { try { pg.task.cancel(); } catch (e) { /* terminé */ } }
  const canvas = pg.el.querySelector('canvas');
  canvas.width = 0;
  canvas.height = 0;
  pg.el.querySelector('.textLayer').innerHTML = '';
  pg.rendered = false;
}

function currentPage() {
  if (!cur || !cur.pages.length || !cur.pages[0].el) return 1;
  const mid = window.innerHeight * 0.35;
  for (const pg of cur.pages) {
    const r = pg.el.getBoundingClientRect();
    if (r.bottom > mid) return pg.n;
  }
  return cur.pages.length;
}
function scrollToPage(n) {
  const pg = cur.pages[n - 1];
  if (!pg || !pg.el) return;
  const top = pg.el.getBoundingClientRect().top + window.scrollY - $('lecBar').offsetHeight - 8;
  window.scrollTo(0, Math.max(0, top));
}
let pageTimer;
function updatePageIndicator() {
  if (!cur || $('view-lecteur').hidden) return;
  const n = currentPage();
  $('lecPage').textContent = n + ' / ' + cur.pages.length;
  clearTimeout(pageTimer);
  pageTimer = setTimeout(() => { try { localStorage.setItem('fc.lastPage.' + cur.doc.id, String(n)); } catch (e) { /* indisponible */ } }, 500);
}
function readLastPage(id) {
  try { return Number(localStorage.getItem('fc.lastPage.' + id)) || 1; } catch (e) { return 1; }
}

function setZoom(dir) {
  if (!cur || !cur.pages.length) return;
  const i = ZOOMS.indexOf(cur.zoom);
  const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + dir))];
  if (next === cur.zoom) return;
  cur.zoom = next;
  layout();
}

// =====================================================================
// Annotations : données et synchronisation
// =====================================================================
function emptyAnn() { return { hl: [], notes: [], ink: [], deleted: [] }; }
const annPath = (id) => 'classeur/notes/' + id + '.json';
const localKey = (id) => 'fc.ann.' + id;

function mergeAnn(a, b) {
  const deleted = [...new Set([...(a.deleted || []), ...(b.deleted || [])])];
  const gone = new Set(deleted);
  const out = { deleted };
  ['hl', 'notes', 'ink'].forEach((k) => {
    const map = new Map();
    [...(a[k] || []), ...(b[k] || [])].forEach((it) => {
      const prev = map.get(it.id);
      if (!prev || (it.t || 0) > (prev.t || 0)) map.set(it.id, it);
    });
    out[k] = [...map.values()].filter((it) => !gone.has(it.id));
  });
  return out;
}

async function loadAnnotations(doc) {
  let local = null;
  try { local = JSON.parse(localStorage.getItem(localKey(doc.id))); } catch (e) { /* rien */ }
  let remote = null;
  if (canSync()) {
    try {
      const f = await state.gh.getFile(state.config.dataRepo, annPath(doc.id));
      if (f) { remote = JSON.parse(f.text); cur.annSha = f.sha; }
    } catch (e) { console.warn('Annotations non lues', e); }
  }
  const ann = mergeAnn(remote || emptyAnn(), (local && local.ann) || emptyAnn());
  cur.dirty = !!(local && local.dirty);
  if (cur.dirty) scheduleSave();
  return ann;
}

let saveTimer = null;
function changed() {
  if (!cur) return;
  cur.dirty = true;
  try { localStorage.setItem(localKey(cur.doc.id), JSON.stringify({ ann: cur.ann, dirty: true })); } catch (e) { /* plein */ }
  scheduleSave();
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveAnnotations(cur), 1500);
}
function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saveAnnotations(cur); }
}
async function saveAnnotations(session) {
  saveTimer = null;
  if (!session || !session.dirty || !canSync()) return;
  const { gh, config } = state;
  const path = annPath(session.doc.id);
  const msg = 'Classeur : annotations de « ' + session.doc.nom + ' »';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = { version: 1, ...session.ann };
      session.annSha = await gh.putFile(config.dataRepo, path, JSON.stringify(data) + '\n', session.annSha, msg);
      session.dirty = false;
      try { localStorage.setItem(localKey(session.doc.id), JSON.stringify({ ann: session.ann, dirty: false })); } catch (e) { /* plein */ }
      return;
    } catch (e) {
      if (!isConflict(e) && e.status !== 422) { console.warn('Annotations non enregistrées', e); return; }
      // Modifiées sur un autre appareil : on relit, on fusionne et on réessaie.
      const f = await gh.getFile(config.dataRepo, path).catch(() => null);
      if (f) {
        session.ann = mergeAnn(JSON.parse(f.text), session.ann);
        session.annSha = f.sha;
        if (cur === session) session.pages.forEach(drawAnnotations);
      } else session.annSha = null;
    }
  }
}

function removeItem(kind, id) {
  cur.ann[kind] = cur.ann[kind].filter((x) => x.id !== id);
  cur.ann.deleted.push(id);
  changed();
}

// =====================================================================
// Dessin des annotations
// =====================================================================
function svgEl(name, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', name);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}
function inkPath(pts) {
  return pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
}
function drawAnnotations(pg) {
  if (!pg.el) return;
  const hl = pg.el.querySelector('.pg-hl');
  const ink = pg.el.querySelector('.pg-ink');
  const notes = pg.el.querySelector('.pg-notes');
  hl.innerHTML = '';
  ink.innerHTML = '';
  notes.innerHTML = '';
  cur.ann.hl.filter((h) => h.p === pg.n).forEach((h) => {
    h.rects.forEach(([x, y, w, hh]) => hl.appendChild(svgEl('rect', { x, y, width: w, height: hh, rx: 3, fill: COLORS[h.c] || COLORS.jaune })));
  });
  cur.ann.ink.filter((s) => s.p === pg.n).forEach((s) => {
    ink.appendChild(svgEl('path', { d: inkPath(s.pts), stroke: COLORS[s.c] || COLORS.bleu, 'stroke-width': s.w || 4, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  });
  cur.ann.notes.filter((nt) => nt.p === pg.n).forEach((nt) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pg-note';
    b.style.left = (nt.x / W * 100) + '%';
    b.style.top = (nt.y / pg.H * 100) + '%';
    b.style.background = COLORS[nt.c] || COLORS.jaune;
    b.setAttribute('aria-label', 'Note : ' + nt.text);
    b.title = nt.text;
    b.textContent = '✎';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (mode === 'gomme') { removeItem('notes', nt.id); drawAnnotations(pg); toast('Note effacée.'); }
      else openNoteSheet(pg, nt);
    });
    notes.appendChild(b);
  });
}

// =====================================================================
// Coordonnées et sélection
// =====================================================================
function pageAt(cx, cy) {
  for (const pg of cur.pages) {
    const r = pg.el.getBoundingClientRect();
    if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return { pg, r };
  }
  return null;
}
function toUnits(pg, r, cx, cy) {
  return [(cx - r.left) / r.width * W, (cy - r.top) / r.height * pg.H];
}

// Rectangles d'une sélection, convertis en unités de page et regroupés ligne par ligne.
function rangeRects(range) {
  const byPage = new Map();
  [...range.getClientRects()].forEach((cr) => {
    if (cr.width < 1 || cr.height < 1) return;
    const hit = pageAt(cr.left + cr.width / 2, cr.top + cr.height / 2);
    if (!hit) return;
    const [x, y] = toUnits(hit.pg, hit.r, cr.left, cr.top);
    const w = cr.width / hit.r.width * W, h = cr.height / hit.r.height * hit.pg.H;
    if (!byPage.has(hit.pg.n)) byPage.set(hit.pg.n, []);
    byPage.get(hit.pg.n).push([x, y, w, h]);
  });
  byPage.forEach((rects, n) => {
    rects.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const merged = [];
    rects.forEach((r) => {
      const m = merged.find((o) => Math.abs((o[1] + o[3] / 2) - (r[1] + r[3] / 2)) < Math.min(o[3], r[3]) * 0.6 && r[0] <= o[0] + o[2] + 12 && r[0] + r[2] >= o[0] - 12);
      if (!m) { merged.push(r.slice()); return; }
      const x1 = Math.min(m[0], r[0]), y1 = Math.min(m[1], r[1]);
      const x2 = Math.max(m[0] + m[2], r[0] + r[2]), y2 = Math.max(m[1] + m[3], r[1] + r[3]);
      m[0] = x1; m[1] = y1; m[2] = x2 - x1; m[3] = y2 - y1;
    });
    byPage.set(n, merged.map((r) => r.map((v) => Math.round(v * 10) / 10)));
  });
  return byPage;
}

function selectionInViewer() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  return $('lecPages').contains(range.commonAncestorContainer) ? range : null;
}

let selHideTimer;
function onSelectionChange() {
  if (!cur || $('view-lecteur').hidden || mode !== 'lire') return;
  const range = selectionInViewer();
  if (range && range.toString().trim()) {
    clearTimeout(selHideTimer);
    lastRange = range.cloneRange();
    $('lecSelBar').hidden = false;
  } else {
    clearTimeout(selHideTimer);
    selHideTimer = setTimeout(hideSelBar, 400); // laisse le temps de toucher un bouton de la barre
  }
}
function hideSelBar() {
  $('lecSelBar').hidden = true;
  lastRange = null;
}

// Crée un surlignage à partir de la sélection. Renvoie le texte surligné.
function highlightSelection() {
  if (!lastRange) return '';
  const text = lastRange.toString().replace(/\s+/g, ' ').trim();
  const byPage = rangeRects(lastRange);
  const t = Date.now();
  byPage.forEach((rects, p) => {
    if (rects.length) cur.ann.hl.push({ id: newId(), p, c: color, rects, text, t });
  });
  try { window.getSelection().removeAllRanges(); } catch (e) { /* rien */ }
  hideSelBar();
  byPage.forEach((_, p) => drawAnnotations(cur.pages[p - 1]));
  changed();
  return text;
}

// =====================================================================
// Création d'une carte à partir d'un passage
// =====================================================================
function createCard(text) {
  const ch = state.byId.get(cur.doc.chapId);
  if (!canEdit()) { toast('Renseigne ton jeton GitHub dans les réglages pour créer des cartes.'); return; }
  if (!ch) { toast('Ce document n\'est rattaché à aucun chapitre de cartes.'); return; }
  flushSave();
  savedScroll = window.scrollY;
  state.editReturn = 'classeur';
  openEditor(ch, null);
  $('fR').value = text;
  $('fR').dispatchEvent(new Event('input'));
  setTimeout(() => $('fQ').focus(), 50);
}

// Appelé par l'éditeur quand on revient de la création de carte.
export function returnToViewer() {
  state.editReturn = null;
  if (!cur) return route();
  showView('lecteur');
  window.scrollTo(0, savedScroll);
  updatePageIndicator();
}

// =====================================================================
// Clics sur les pages selon l'outil
// =====================================================================
function distToSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function hitHighlight(n, pt) {
  return cur.ann.hl.find((h) => h.p === n && h.rects.some(([x, y, w, hh]) => pt[0] >= x - 4 && pt[0] <= x + w + 4 && pt[1] >= y - 4 && pt[1] <= y + hh + 4));
}
function hitInk(n, pt) {
  return cur.ann.ink.find((s) => s.p === n && s.pts.some((q, i) => i && distToSeg(pt, s.pts[i - 1], q) < 14));
}

function onPagesClick(e) {
  if (!cur || mode === 'dessin') return;
  if (e.target.closest('.pg-note')) return;
  const hit = pageAt(e.clientX, e.clientY);
  if (!hit) return;
  const pt = toUnits(hit.pg, hit.r, e.clientX, e.clientY);
  if (mode === 'note') { openNoteSheet(hit.pg, null, pt); return; }
  if (mode === 'gomme') {
    const h = hitHighlight(hit.pg.n, pt);
    const s = !h && hitInk(hit.pg.n, pt);
    if (h) { removeItem('hl', h.id); toast('Surlignage effacé.'); }
    else if (s) { removeItem('ink', s.id); toast('Trait effacé.'); }
    drawAnnotations(hit.pg);
    return;
  }
  if (selectionInViewer()) return;
  const h = hitHighlight(hit.pg.n, pt);
  if (h) openHighlightSheet(hit.pg, h);
}

// ---------- Dessin ----------
let stroke = null;
function onInkDown(e) {
  if (mode !== 'dessin' || !cur) return;
  const svg = e.target.closest('.pg-ink');
  if (!svg) return;
  const pg = cur.pages[Number(svg.parentNode.dataset.n) - 1];
  const r = pg.el.getBoundingClientRect();
  e.preventDefault();
  svg.setPointerCapture(e.pointerId);
  const path = svgEl('path', { stroke: COLORS[color], 'stroke-width': 4, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  svg.appendChild(path);
  stroke = { pg, r, svg, path, id: e.pointerId, pts: [toUnits(pg, r, e.clientX, e.clientY)] };
  path.setAttribute('d', inkPath(stroke.pts));
}
function onInkMove(e) {
  if (!stroke || e.pointerId !== stroke.id) return;
  e.preventDefault();
  const p = toUnits(stroke.pg, stroke.r, e.clientX, e.clientY);
  const last = stroke.pts[stroke.pts.length - 1];
  if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1.5) return;
  stroke.pts.push(p);
  stroke.path.setAttribute('d', inkPath(stroke.pts));
}
function onInkUp(e) {
  if (!stroke || e.pointerId !== stroke.id) return;
  const s = stroke;
  stroke = null;
  if (s.pts.length < 2) s.pts.push([s.pts[0][0] + 0.5, s.pts[0][1] + 0.5]);
  cur.ann.ink.push({ id: newId(), p: s.pg.n, c: color, w: 4, pts: s.pts.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]), t: Date.now() });
  changed();
  drawAnnotations(s.pg);
}

// =====================================================================
// Panneaux (surlignage, note)
// =====================================================================
function swatchesHtml(selected, cls) {
  return Object.keys(COLORS).map((k) => '<button type="button" class="swatch ' + cls + (k === selected ? ' on' : '') + '" data-color="' + k + '" style="--sw:' + COLORS[k] + '" aria-label="Couleur ' + COLOR_NAMES[k] + '"></button>').join('');
}
function closeSheet() {
  $('lecSheet').hidden = true;
  $('lecSheet').innerHTML = '';
}

function openHighlightSheet(pg, h) {
  const sheet = $('lecSheet');
  sheet.innerHTML =
    '<p class="sheet-quote"></p>' +
    '<div class="swatches" role="group" aria-label="Couleur du surlignage">' + swatchesHtml(h.c, 'sh-color') + '</div>' +
    '<div class="row"><button type="button" class="primary" id="shCard">Créer une carte</button>' +
    '<button type="button" class="again" id="shDel">Supprimer</button><button type="button" class="ghost" id="shClose">Fermer</button></div>';
  sheet.querySelector('.sheet-quote').textContent = '« ' + (h.text || 'Passage surligné') + ' »';
  sheet.querySelectorAll('.sh-color').forEach((b) => b.addEventListener('click', () => {
    h.c = b.dataset.color;
    h.t = Date.now();
    changed();
    drawAnnotations(pg);
    sheet.querySelectorAll('.sh-color').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('shCard').addEventListener('click', () => { closeSheet(); createCard(h.text || ''); });
  $('shDel').addEventListener('click', () => { removeItem('hl', h.id); drawAnnotations(pg); closeSheet(); });
  $('shClose').addEventListener('click', closeSheet);
  sheet.hidden = false;
}

function openNoteSheet(pg, note, pt) {
  const sheet = $('lecSheet');
  let c = note ? note.c : color;
  sheet.innerHTML =
    '<label for="noteText" class="sheet-label">' + (note ? 'Note' : 'Nouvelle note') + ' · page ' + pg.n + '</label>' +
    '<textarea id="noteText" rows="3" placeholder="Ta note"></textarea>' +
    '<div class="swatches" role="group" aria-label="Couleur de la note">' + swatchesHtml(c, 'nt-color') + '</div>' +
    '<div class="row"><button type="button" class="primary" id="ntSave">Enregistrer</button>' +
    (note ? '<button type="button" class="again" id="ntDel">Supprimer</button>' : '') +
    '<button type="button" class="ghost" id="ntClose">Fermer</button></div>';
  $('noteText').value = note ? note.text : '';
  sheet.querySelectorAll('.nt-color').forEach((b) => b.addEventListener('click', () => {
    c = b.dataset.color;
    sheet.querySelectorAll('.nt-color').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('ntSave').addEventListener('click', () => {
    const text = $('noteText').value.trim();
    if (!text) { $('noteText').focus(); return; }
    if (note) Object.assign(note, { text, c, t: Date.now() });
    else cur.ann.notes.push({ id: newId(), p: pg.n, x: Math.round(pt[0]), y: Math.round(pt[1]), text, c, t: Date.now() });
    changed();
    drawAnnotations(pg);
    closeSheet();
  });
  if (note) $('ntDel').addEventListener('click', () => { removeItem('notes', note.id); drawAnnotations(pg); closeSheet(); });
  $('ntClose').addEventListener('click', closeSheet);
  sheet.hidden = false;
  setTimeout(() => $('noteText').focus(), 50);
}

// =====================================================================
// Outils
// =====================================================================
function setMode(m) {
  mode = m;
  document.querySelectorAll('#lecModes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('lecPages').classList.toggle('drawing', m === 'dessin');
  $('lecPages').classList.toggle('erasing', m === 'gomme');
  $('lecPages').classList.toggle('noting', m === 'note');
  $('lecHint').textContent = HINTS[m];
  if (m !== 'lire') { hideSelBar(); try { window.getSelection().removeAllRanges(); } catch (e) { /* rien */ } }
}
function setColor(c) {
  color = c;
  document.querySelectorAll('.lec-color').forEach((b) => b.classList.toggle('on', b.dataset.color === c));
}

export function bindViewer() {
  $('lecColors').innerHTML = swatchesHtml(color, 'lec-color');
  $('lecSelColors').innerHTML = swatchesHtml(color, 'lec-color');
  document.querySelectorAll('.lec-color').forEach((b) => b.addEventListener('click', () => setColor(b.dataset.color)));
  document.querySelectorAll('#lecModes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('lecBack').addEventListener('click', () => closeViewer(true));
  $('lecZoomIn').addEventListener('click', () => setZoom(1));
  $('lecZoomOut').addEventListener('click', () => setZoom(-1));
  $('lecCards').addEventListener('click', () => { const d = cur && cur.doc; if (d) { closeViewer(false); generateFromDoc(d); } });
  $('lecPages').addEventListener('click', onPagesClick);
  $('lecPages').addEventListener('pointerdown', onInkDown);
  $('lecPages').addEventListener('pointermove', onInkMove);
  $('lecPages').addEventListener('pointerup', onInkUp);
  $('lecPages').addEventListener('pointercancel', onInkUp);
  document.addEventListener('selectionchange', onSelectionChange);
  // Les boutons de la barre de sélection agissent dès l'appui, avant que le téléphone n'efface la sélection.
  const act = (id, fn) => {
    const b = $(id);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.dataset.fired = '1'; fn(); });
    b.addEventListener('click', () => { if (b.dataset.fired) { delete b.dataset.fired; return; } fn(); });
  };
  act('lecHl', () => { if (highlightSelection()) toast('Passage surligné.'); });
  act('lecHlCard', () => { const text = highlightSelection(); if (text) createCard(text); });
  document.querySelectorAll('#lecSelColors .lec-color').forEach((b) => b.addEventListener('pointerdown', (e) => e.preventDefault()));
  window.addEventListener('scroll', () => { if (cur) updatePageIndicator(); }, { passive: true });
  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (cur && !$('view-lecteur').hidden && cur.pages.length) layout(); }, 300);
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
  document.addEventListener('keydown', (e) => {
    if (!cur || $('view-lecteur').hidden || e.target.matches('input, textarea, select')) return;
    if (e.key === 'Escape') { if (!$('lecSheet').hidden) closeSheet(); else closeViewer(true); }
  });
}
