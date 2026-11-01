// Onglet Calendrier : devoirs, DS, colles et tâches, en vue Semaine (inspiré de Rappels d'Apple).
// Données dans le dépôt privé (agenda.json), fusionnées entre appareils comme les annotations.
import { isConflict } from './github.js?v=20261101194810';
import * as S from './store.js?v=20261101194810';
import { $, state, escapeHtml, toast, plural, canSync, newId, showView, route } from './ui.js?v=20261101194810';
import { startPractice } from './practice.js?v=20261101194810';
import { openClasseurDoc } from './classeur.js?v=20261101194810';

export const TYPES = { devoir: 'Devoir', ds: 'DS', colle: 'Colle', tache: 'Tâche' };
const PRIOS = ['', '!', '!!', '!!!'];
const PATH = 'agenda.json';
const LS = 'fc.agenda';
const DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
// Palette de 12 couleurs lisibles en thème clair comme en sombre.
export const PALETTE = {
  bleu: '#2f6fe4', ciel: '#0ea5e9', turquoise: '#0f9fb5', vert: '#1f9d55', olive: '#65a30d', jaune: '#ca8a04',
  orange: '#e8730c', rouge: '#dc2626', rose: '#d6336c', violet: '#8a4fd8', indigo: '#4f46e5', gris: '#6b7280',
};
const DEFAULT_COLORS = { maths: 'bleu', physique: 'orange', chimie: 'vert', si: 'violet', anglais: 'rose', francais: 'rouge' };
const SPARE = ['turquoise', 'jaune', 'rouge', 'indigo', 'olive', 'ciel'];

let agenda = { items: [], deleted: [] };
let sha = null;
let dirty = false;
let selDay = todayIso();          // jour sélectionné dans la grille
let viewMonth = todayIso().slice(0, 7); // mois affiché (grille dépliée)
let collapsed = readPref('fc.agCollapsed') === '1'; // grille repliée en une semaine (téléphone)
// Sur ordinateur : toujours le grand mois, avec la liste du jour choisi à côté.
const desk = matchMedia('(min-width: 900px)');
const weekMode = () => collapsed && !desk.matches;
let scrollToSel = false;
function readPref(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function writePref(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* indisponible */ } }
let hideDone = false;
let editing = null; // copie de l'élément ouvert dans la fiche
let quickDay = null; // jour où la ligne d'ajout rapide est ouverte

// =====================================================================
// Dates (jours calendaires locaux)
// =====================================================================
function iso(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function parse(day) { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, 12); }
export function todayIso() { return iso(new Date()); }
function addDays(day, n) { const d = parse(day); d.setDate(d.getDate() + n); return iso(d); }
function mondayOf(day) { const d = parse(day); return addDays(day, -((d.getDay() + 6) % 7)); }
function fmtDay(day, opts) { return parse(day).toLocaleDateString('fr-FR', opts); }
function relDay(day) {
  const t = todayIso();
  if (day === t) return 'Aujourd\'hui';
  if (day === addDays(t, 1)) return 'Demain';
  if (day === addDays(t, -1)) return 'Hier';
  return fmtDay(day, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function matColorKey(matId) {
  const chosen = ((state.progress.settings || {}).matColors || {})[matId];
  if (chosen && PALETTE[chosen]) return chosen;
  if (DEFAULT_COLORS[matId]) return DEFAULT_COLORS[matId];
  const i = state.matieres.findIndex((m) => m.id === matId);
  return i >= 0 ? SPARE[i % SPARE.length] : 'gris';
}
export function matColor(matId) {
  return matId ? PALETTE[matColorKey(matId)] : 'var(--muted)';
}

// =====================================================================
// Données et synchronisation
// =====================================================================
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
function saveLocal() {
  try { localStorage.setItem(LS, JSON.stringify({ agenda, dirty })); } catch (e) { /* plein */ }
}
function loadLocal() {
  try {
    const l = JSON.parse(localStorage.getItem(LS));
    if (l && l.agenda) { agenda = merge(agenda, l.agenda); dirty = !!l.dirty; }
  } catch (e) { /* rien */ }
}

export async function loadAgenda() {
  loadLocal();
  if (!canSync()) return;
  try {
    const f = await state.gh.getFile(state.config.dataRepo, PATH);
    if (f) { agenda = merge(JSON.parse(f.text), agenda); sha = f.sha; }
    saveLocal();
    if (dirty) scheduleSave(500);
  } catch (e) { console.warn('Agenda non lu', e); }
}

let saveTimer = null;
function changed() {
  dirty = true;
  saveLocal();
  scheduleSave(1500);
}
function scheduleSave(delay) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(pushAgenda, delay);
}
export function flushAgenda() { if (saveTimer) { clearTimeout(saveTimer); pushAgenda(); } }
async function pushAgenda() {
  saveTimer = null;
  if (!dirty || !canSync()) return;
  const { gh, config } = state;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      sha = await gh.putFile(config.dataRepo, PATH, JSON.stringify({ version: 1, ...agenda }) + '\n', sha, 'Calendrier : mise à jour');
      dirty = false;
      saveLocal();
      return;
    } catch (e) {
      if (!isConflict(e) && e.status !== 422) { console.warn('Agenda non enregistré', e); return; }
      const f = await gh.getFile(config.dataRepo, PATH).catch(() => null);
      if (f) { agenda = merge(JSON.parse(f.text), agenda); sha = f.sha; } else sha = null;
    }
  }
}

function upsert(item) {
  item.t = Date.now();
  const i = agenda.items.findIndex((x) => x.id === item.id);
  if (i >= 0) agenda.items[i] = item; else agenda.items.push(item);
  changed();
  setTimeout(() => document.dispatchEvent(new Event('nav-refresh')), 650);
}
function remove(id) {
  agenda.items = agenda.items.filter((x) => x.id !== id);
  agenda.deleted.push(id);
  changed();
}

// Éléments à faire aujourd'hui et en retard (pour l'écran Réviser).
// DS et colles à venir, pour le planificateur d'examen (avec ou sans chapitres).
export function examsAhead() {
  const t = todayIso();
  return agenda.items.filter((it) => !it.done && (it.type === 'ds' || it.type === 'colle') && it.date && it.date > t).sort(compare);
}
export { openItem as openAgendaItem };

export function dueNow() {
  const t = todayIso();
  return agenda.items.filter((it) => !it.done && it.date && it.date <= t).sort(compare);
}
// DS et colles à venir dans les 14 jours (ceux du jour sont déjà dans « À faire »).
export function upcomingExams() {
  const t = todayIso(), lim = addDays(t, 14);
  return agenda.items.filter((it) => !it.done && (it.type === 'ds' || it.type === 'colle') && it.date && it.date > t && it.date <= lim).sort(compare);
}

function compare(a, b) {
  return (a.done - b.done) || (a.date || '9999').localeCompare(b.date || '9999') ||
    (a.time || '99').localeCompare(b.time || '99') || (b.prio || 0) - (a.prio || 0) ||
    (b.flag ? 1 : 0) - (a.flag ? 1 : 0) || (a.created || 0) - (b.created || 0);
}

// Type deviné à partir du titre tapé rapidement : « DS de physique » → DS, « Colle d'anglais » → Colle.
function guessType(title) {
  if (/^\s*(ds|devoir surveill)/i.test(title)) return 'ds';
  if (/^\s*colle/i.test(title)) return 'colle';
  if (/^\s*(dm|devoir|exo|exercice|td)/i.test(title)) return 'devoir';
  return 'devoir';
}
function guessMatiere(title) {
  const t = title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const m = state.matieres.find((x) => {
    const n = x.nom.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return new RegExp('\\b(' + n + '|' + x.id + ')\\b').test(t);
  });
  return m ? m.id : '';
}

// =====================================================================
// Vue Semaine
// =====================================================================
const WD = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
function monthTitle(ym) {
  const t = parse(ym + '-01').toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function shiftMonth(ym, n) {
  const d = parse(ym + '-01');
  d.setMonth(d.getMonth() + n);
  return iso(d).slice(0, 7);
}

export function renderAgenda() {
  const t = todayIso();
  $('agLocked').hidden = canSync();
  $('agMonthTitle').textContent = monthTitle(weekMode() ? selDay.slice(0, 7) : viewMonth);
  document.querySelectorAll('#agMode button').forEach((b) => b.classList.toggle('on', (b.dataset.mode === 'semaine') === weekMode()));
  $('agToday').disabled = selDay === t && (weekMode() || viewMonth === t.slice(0, 7));
  $('agHideDone').textContent = hideDone ? 'Afficher les terminés' : 'Masquer les terminés';
  $('agCal').classList.toggle('collapsed', weekMode());
  $('agQuickInput').placeholder = 'Ajouter ' + (selDay === t ? 'aujourd\'hui' : selDay === addDays(t, 1) ? 'demain' : 'le ' + fmtDay(selDay, { weekday: 'long', day: 'numeric', month: 'short' })) + '…';
  renderGrid();
  renderWeekList();
}

// Points d'un jour : une couleur par matière (au plus 3), en anneau s'il y a un DS ou une colle.
function dotsFor(day) {
  const items = agenda.items.filter((it) => it.date === day && !it.done);
  const byMat = new Map();
  items.forEach((it) => {
    const k = it.mat || '';
    const exam = it.type === 'ds' || it.type === 'colle';
    byMat.set(k, (byMat.get(k) || false) || exam);
  });
  const order = state.matieres.map((m) => m.id);
  const keys = [...byMat.keys()].sort((a, b) => (a === '' ? 99 : order.indexOf(a)) - (b === '' ? 99 : order.indexOf(b)));
  const shown = keys.slice(0, 3).map((k) => '<i class="dot' + (byMat.get(k) ? ' ring' : '') + '" style="--c:' + matColor(k) + '"></i>').join('');
  return shown + (keys.length > 3 ? '<i class="dot-more">+</i>' : '');
}

function renderGrid() {
  const grid = $('agGrid');
  const t = todayIso();
  let days;
  if (weekMode()) {
    const start = mondayOf(selDay);
    days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  } else {
    const first = viewMonth + '-01';
    const start = mondayOf(first);
    const last = addDays(shiftMonth(viewMonth, 1) + '-01', -1);
    const end = addDays(mondayOf(last), 6);
    days = [];
    for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  }
  const month = weekMode() ? selDay.slice(0, 7) : viewMonth;
  grid.innerHTML = WD.map((w) => '<span class="wd" aria-hidden="true">' + w + '</span>').join('');
  days.forEach((day) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cal-day' + (day === t ? ' today' : '') + (day === selDay ? ' sel' : '') + (day.slice(0, 7) !== month ? ' other' : '') + (day < t ? ' past' : '');
    const n = agenda.items.filter((it) => it.date === day && !it.done).length;
    b.setAttribute('aria-label', fmtDay(day, { weekday: 'long', day: 'numeric', month: 'long' }) + (n ? ', ' + plural(n, 'élément', 'éléments') : ''));
    if (day === selDay) b.setAttribute('aria-pressed', 'true');
    b.innerHTML = '<span class="num">' + Number(day.slice(8)) + '</span>' + (desk.matches ? chipsFor(day) : '<span class="dots">' + dotsFor(day) + '</span>');
    b.addEventListener('click', () => selectDay(day));
    grid.appendChild(b);
  });
}

// Ordinateur : titres des éléments dans la case du jour (3 au plus).
function chipsFor(day) {
  const items = agenda.items.filter((it) => it.date === day && !(hideDone && it.done)).sort(compare);
  const chips = items.slice(0, 3).map((it) => '<span class="cal-chip' + (it.done ? ' done' : '') + (it.type === 'ds' || it.type === 'colle' ? ' exam' : '') +
    '" style="--c:' + matColor(it.mat) + '">' + (it.type === 'ds' || it.type === 'colle' ? TYPES[it.type] + ' · ' : '') + escapeHtml(it.title) + '</span>').join('');
  return '<span class="cal-chips">' + chips + (items.length > 3 ? '<span class="cal-more">+' + (items.length - 3) + ' autres</span>' : '') + '</span>';
}

// Ordinateur : liste détaillée du jour choisi, à droite du mois.
function renderDayPanel(box) {
  const t = todayIso();
  const visible = (it) => !(hideDone && it.done);
  const title = fmtDay(selDay, { weekday: 'long', day: 'numeric', month: 'long' });
  const items = agenda.items.filter((it) => it.date === selDay && visible(it)).sort(compare);
  const sec = section(title.charAt(0).toUpperCase() + title.slice(1), [selDay === t ? 'today' : selDay < t ? 'past' : '', 'sel'].filter(Boolean).join(' '), items, selDay);
  sec.dataset.day = selDay;
  box.appendChild(sec);
  const overdue = agenda.items.filter((it) => !it.done && it.date && it.date < t).sort(compare);
  if (overdue.length) box.appendChild(section('En retard', 'late', overdue, null));
  const undated = agenda.items.filter((it) => !it.date && visible(it)).sort(compare);
  if (undated.length || quickDay === '') box.appendChild(section('Sans date', 'undated', undated, ''));
}

function selectDay(day) {
  selDay = day;
  if (!weekMode()) viewMonth = day.slice(0, 7);
  scrollToSel = true;
  renderAgenda();
}

// Liste détaillée : retards, sans date, puis les 7 jours de la semaine du jour choisi.
function renderWeekList() {
  const box = $('agWeek');
  box.innerHTML = '';
  if (desk.matches) { renderDayPanel(box); return; }
  const t = todayIso();
  const start = mondayOf(selDay);
  const visible = (it) => !(hideDone && it.done);
  const overdue = agenda.items.filter((it) => !it.done && it.date && it.date < t).sort(compare);
  const undated = agenda.items.filter((it) => !it.date && visible(it)).sort(compare);
  if (overdue.length) box.appendChild(section('En retard', 'late', overdue, null));
  if (undated.length || quickDay === '') box.appendChild(section('Sans date', 'undated', undated, ''));
  for (let i = 0; i < 7; i++) {
    const day = addDays(start, i);
    const items = agenda.items.filter((it) => it.date === day && visible(it) && !(it.date < t && !it.done)).sort(compare);
    const title = DAYS[i].charAt(0).toUpperCase() + DAYS[i].slice(1) + ' ' + fmtDay(day, { day: 'numeric', month: 'short' });
    const sec = section(title, [day === t ? 'today' : day < t ? 'past' : '', day === selDay ? 'sel' : ''].filter(Boolean).join(' '), items, day);
    sec.dataset.day = day;
    box.appendChild(sec);
  }
  if (quickDay !== null) {
    const input = box.querySelector('.quick-input');
    if (input) input.focus({ preventScroll: true });
  }
  if (scrollToSel) {
    scrollToSel = false;
    const sec = box.querySelector('[data-day="' + selDay + '"]');
    if (sec) {
      const top = sec.getBoundingClientRect().top + window.scrollY - ($('agCal').classList.contains('collapsed') ? $('agCal').offsetHeight + 12 : 12);
      if (Math.abs(top - window.scrollY) > 40) window.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }
}

function section(title, cls, items, day) {
  const sec = document.createElement('section');
  sec.className = 'ag-day' + (cls ? ' ' + cls : '') + (!items.length && day ? ' empty' : '');
  const count = items.filter((it) => !it.done).length;
  sec.innerHTML = '<div class="ag-day-head"><h2></h2><span class="ag-count">' + (count || '') + '</span></div><ul class="ag-list"></ul>';
  sec.querySelector('h2').textContent = title + (/\btoday\b/.test(cls) ? ' · aujourd\'hui' : '');
  if (day !== null) {
    // Le « + » est dans l'en-tête : un jour vide ne prend qu'une ligne.
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'ag-add-head';
    add.textContent = '+';
    add.setAttribute('aria-label', 'Ajouter ' + (day ? 'le ' + fmtDay(day, { weekday: 'long', day: 'numeric', month: 'long' }) : 'sans date'));
    add.addEventListener('click', () => { quickDay = day; renderAgenda(); });
    sec.querySelector('.ag-day-head').appendChild(add);
  }
  const ul = sec.querySelector('ul');
  items.forEach((it) => ul.appendChild(row(it, cls === 'late')));
  if (day !== null && quickDay === day) ul.appendChild(quickRow(day));
  else if (day && !items.length) ul.insertAdjacentHTML('beforeend', '<li class="ag-none">Rien de prévu</li>');
  return sec;
}

function metaLine(it, showDate) {
  const parts = [];
  if (it.type !== 'tache') parts.push('<span class="ag-type t-' + it.type + '">' + TYPES[it.type] + '</span>');
  if (showDate && it.date) parts.push(escapeHtml(relDay(it.date)));
  if (it.time) parts.push(escapeHtml(it.time.replace(':', ' h ')));
  const m = state.matieres.find((x) => x.id === it.mat);
  if (m) {
    const chs = (it.chaps || []).map((id) => state.byId.get(id)).filter(Boolean);
    parts.push('<span class="ag-mat"><i style="background:' + matColor(m.id) + '"></i>' + escapeHtml(m.nom) +
      (chs.length ? ' · ' + escapeHtml(chs.map((c) => c.nom).join(', ')) : '') + '</span>');
  }
  if (it.subs && it.subs.length) parts.push(it.subs.filter((s) => s.done).length + '/' + it.subs.length);
  if (it.notes) parts.push('note');
  return parts.join(' · ');
}

function row(it, showDate) {
  const li = document.createElement('li');
  li.className = 'ag-item' + (it.done ? ' done' : '');
  const c = it.mat ? matColor(it.mat) : 'var(--muted)';
  li.innerHTML =
    '<button type="button" class="ag-check" role="checkbox" aria-checked="' + !!it.done + '" style="--c:' + c + '"></button>' +
    '<button type="button" class="ag-body"><span class="ag-title"><span class="ag-prio"></span><span class="ag-text"></span>' +
    (it.flag ? '<span class="ag-flag" aria-label="Drapeau">⚑</span>' : '') + '</span><span class="ag-meta">' + metaLine(it, showDate) + '</span></button>';
  li.querySelector('.ag-prio').textContent = PRIOS[it.prio || 0] ? PRIOS[it.prio] + ' ' : '';
  li.querySelector('.ag-text').textContent = it.title;
  li.querySelector('.ag-check').setAttribute('aria-label', (it.done ? 'Marquer « ' : 'Terminer « ') + it.title + ' »' + (it.done ? ' comme à faire' : ''));
  li.querySelector('.ag-check').addEventListener('click', () => toggleDone(it, li));
  // Toucher l'élément déplie son détail (texte, pièces jointes…) ; « Modifier » ouvre la fiche.
  const detail = detailOf(it);
  if (detail) {
    li.classList.add('has-detail');
    const box = document.createElement('div');
    box.className = 'ag-detail';
    box.hidden = true;
    box.appendChild(detail);
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'ghost small ag-edit';
    edit.textContent = 'Modifier';
    edit.addEventListener('click', () => openItem(it));
    box.appendChild(edit);
    li.querySelector('.ag-body').after(box);
    li.querySelector('.ag-body').setAttribute('aria-expanded', 'false');
    li.querySelector('.ag-body').addEventListener('click', () => {
      box.hidden = !box.hidden;
      li.classList.toggle('open', !box.hidden);
      li.querySelector('.ag-body').setAttribute('aria-expanded', String(!box.hidden));
    });
  } else {
    li.querySelector('.ag-body').addEventListener('click', () => openItem(it));
  }
  if ((it.type === 'ds' || it.type === 'colle') && !it.done && (it.chaps || []).length) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost small ag-prep';
    b.textContent = 'Réviser';
    b.setAttribute('aria-label', 'Réviser les chapitres de « ' + it.title + ' »');
    b.addEventListener('click', () => prepare(it));
    li.appendChild(b);
  }
  return li;
}

// Contenu du détail : notes (liens cliquables), étapes, chapitres, pièces jointes. null s'il n'y a rien.
function linkify(text) {
  return escapeHtml(text).replace(/\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)/g, (m, inParen, bare) => {
    const url = inParen || bare;
    return (inParen ? ' ' : '') + '<a href="' + url + '" target="_blank" rel="noopener">' + (inParen ? 'lien' : url.replace(/^https?:\/\//, '').slice(0, 40) + '…') + '</a>';
  }).replace(/\n/g, '<br>');
}
function detailOf(it) {
  const parts = [];
  if (it.notes && it.notes.trim()) parts.push('<p class="ag-notes">' + linkify(it.notes.trim()) + '</p>');
  if ((it.subs || []).length) parts.push('<ul class="ag-subs">' + it.subs.map((x) => '<li class="' + (x.done ? 'done' : '') + '">' + (x.done ? '☑ ' : '☐ ') + escapeHtml(x.title || x.text || '') + '</li>').join('') + '</ul>');
  const atts = it.attachments || [];
  if (!parts.length && !atts.length) return null;
  const frag = document.createElement('div');
  frag.innerHTML = parts.join('');
  if (atts.length) {
    const ul = document.createElement('ul');
    ul.className = 'ag-atts';
    atts.forEach((a) => {
      const li = document.createElement('li');
      const b = document.createElement(a.url && !a.file ? 'a' : 'button');
      b.className = 'ag-att';
      b.textContent = '📎 ' + a.name;
      if (a.url && !a.file) {
        b.href = a.url; b.target = '_blank'; b.rel = 'noopener';
        b.title = 'S\'ouvre sur Mon Bureau Numérique (connexion à l\'ENT nécessaire)';
      } else {
        b.type = 'button';
        b.addEventListener('click', () => openAttachment(a));
      }
      li.appendChild(b);
      ul.appendChild(li);
    });
    frag.appendChild(ul);
    if (atts.some((a) => a.url && !a.file)) frag.insertAdjacentHTML('beforeend', '<p class="ag-att-hint">Les pièces jointes s\'ouvrent sur Mon Bureau Numérique.</p>');
  }
  return frag;
}
async function openAttachment(a) {
  try {
    if (a.doc) { openClasseurDoc(a.doc); return; }
    toast('Téléchargement…');
    const buf = await state.gh.getBinary(state.config.dataRepo, a.file);
    const url = URL.createObjectURL(new Blob([buf], { type: a.mime || 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url; link.download = a.name;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) { toast('Ouverture impossible : ' + e.message); }
}

function toggleDone(it, li) {
  const item = { ...it, done: !it.done, doneAt: it.done ? null : Date.now() };
  upsert(item);
  if (li) {
    li.classList.toggle('done', item.done);
    li.querySelector('.ag-check').setAttribute('aria-checked', String(item.done));
  }
  // Laisse voir la coche avant de réorganiser la liste, comme dans Rappels.
  setTimeout(() => { if (!$('view-calendrier').hidden) renderAgenda(); else if (!$('view-reviser').hidden) route(); }, 600);
}

function quickRow(day) {
  const li = document.createElement('li');
  li.className = 'ag-item quick';
  li.innerHTML = '<span class="ag-check ghosted" aria-hidden="true"></span><input class="quick-input" type="text" autocomplete="off" placeholder="Nouveau : « DS de physique », « DM maths »…" aria-label="Titre du nouvel élément">' +
    '<button type="button" class="ghost small ag-more" aria-label="Détails">Détails</button>';
  const input = li.querySelector('input');
  const create = () => {
    const title = input.value.trim();
    if (!title) return null;
    const item = { id: newId(), title, type: guessType(title), mat: guessMatiere(title), chaps: [], date: day || null, time: null, prio: 0, flag: false, notes: '', subs: [], done: false, created: Date.now() };
    upsert(item);
    input.value = '';
    return item;
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (create()) renderAgenda(); } // la ligne reste ouverte pour enchaîner
    else if (e.key === 'Escape') { quickDay = null; renderAgenda(); }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement && document.activeElement.closest && document.activeElement.closest('.ag-item.quick')) return;
      const made = create();
      quickDay = null;
      if (!$('view-calendrier').hidden && $('view-tache').hidden) renderAgenda();
      if (made) toast('Ajouté.');
    }, 150);
  });
  li.querySelector('.ag-more').addEventListener('pointerdown', (e) => e.preventDefault());
  li.querySelector('.ag-more').addEventListener('click', () => {
    const made = create();
    quickDay = null;
    openItem(made || { id: newId(), title: '', type: 'devoir', mat: '', chaps: [], date: day || null, time: null, prio: 0, flag: false, notes: '', subs: [], done: false, created: Date.now() }, !made);
  });
  return li;
}

function prepare(it) {
  const items = (it.chaps || []).map((id) => state.byId.get(id)).filter(Boolean).flatMap((ch) => S.faces(ch));
  if (!items.length) { toast('Ajoute des chapitres à cet élément pour pouvoir les réviser.'); return; }
  startPractice(items, 'cram');
}

// =====================================================================
// Fiche détaillée
// =====================================================================
export function openItem(it, isNew = false) {
  editing = { ...it, chaps: [...(it.chaps || [])], subs: (it.subs || []).map((s) => ({ ...s })), _new: isNew };
  $('tkTitle').value = editing.title;
  document.querySelectorAll('#tkTypes button').forEach((b) => b.classList.toggle('on', b.dataset.type === editing.type));
  $('tkHasDate').checked = !!editing.date;
  $('tkDate').value = editing.date || todayIso();
  $('tkDateBox').hidden = !editing.date;
  $('tkHasTime').checked = !!editing.time;
  $('tkTime').value = editing.time || '08:00';
  $('tkTimeRow').hidden = !editing.date;
  $('tkTime').hidden = !editing.time;
  $('tkMat').innerHTML = '<option value="">Aucune</option>' + state.matieres.map((m) => '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.nom) + '</option>').join('');
  $('tkMat').value = editing.mat || '';
  renderChaps();
  document.querySelectorAll('#tkPrio button').forEach((b) => b.classList.toggle('on', Number(b.dataset.p) === (editing.prio || 0)));
  $('tkFlag').checked = !!editing.flag;
  $('tkNotes').value = editing.notes || '';
  renderSubs();
  $('tkDelete').hidden = isNew;
  $('tkDeleteConfirm').hidden = true;
  updatePrep();
  showView('tache');
  if (!editing.title) setTimeout(() => $('tkTitle').focus(), 50);
}

function renderChaps() {
  const box = $('tkChaps');
  const chs = state.chapters.filter((c) => c.matiere === editing.mat);
  $('tkChapsBox').hidden = !chs.length;
  box.innerHTML = '';
  chs.forEach((c) => {
    const l = document.createElement('label');
    l.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'tkc-' + c.id;
    cb.checked = editing.chaps.includes(c.id);
    cb.addEventListener('change', () => {
      editing.chaps = cb.checked ? [...editing.chaps, c.id] : editing.chaps.filter((x) => x !== c.id);
      updatePrep();
    });
    l.append(cb, document.createTextNode(c.nom));
    box.appendChild(l);
  });
}

function renderSubs() {
  const ul = $('tkSubs');
  ul.innerHTML = '';
  editing.subs.forEach((s) => {
    const li = document.createElement('li');
    li.className = 'tk-sub' + (s.done ? ' done' : '');
    li.innerHTML = '<button type="button" class="ag-check small" role="checkbox" aria-checked="' + !!s.done + '" aria-label="Cocher l\'étape"></button>' +
      '<input type="text" autocomplete="off" aria-label="Étape"><button type="button" class="ghost small tk-sub-del" aria-label="Supprimer l\'étape">×</button>';
    const input = li.querySelector('input');
    input.value = s.text;
    input.addEventListener('input', () => { s.text = input.value; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('tkSubNew').focus(); } });
    li.querySelector('.ag-check').addEventListener('click', () => { s.done = !s.done; renderSubs(); });
    li.querySelector('.tk-sub-del').addEventListener('click', () => { editing.subs = editing.subs.filter((x) => x !== s); renderSubs(); });
    ul.appendChild(li);
  });
}

function updatePrep() {
  const exam = editing.type === 'ds' || editing.type === 'colle';
  $('tkPrep').hidden = !exam;
  $('tkPrepBtn').disabled = !editing.chaps.length;
  $('tkPrepHint').textContent = editing.chaps.length
    ? ((editing.type === 'ds' || editing.type === 'colle') ? 'Avec une date, les cartes de ces chapitres s\'ajoutent chaque jour à ta révision du jour jusqu\'au ' + (editing.type === 'ds' ? 'DS' : 'jour de la colle') + '. ' : '') +
      'Le bouton lance un bachotage sur ' + plural(editing.chaps.length, 'chapitre coché', 'chapitres cochés') + ', sans toucher à ta progression.'
    : 'Coche les chapitres au programme pour pouvoir les réviser d\'ici le ' + (TYPES[editing.type] || '') + '.';
}

function readForm() {
  editing.title = $('tkTitle').value.trim();
  editing.date = $('tkHasDate').checked ? $('tkDate').value || todayIso() : null;
  editing.time = editing.date && $('tkHasTime').checked ? $('tkTime').value || null : null;
  editing.mat = $('tkMat').value;
  editing.flag = $('tkFlag').checked;
  editing.notes = $('tkNotes').value.trim();
  editing.subs = editing.subs.filter((s) => s.text.trim());
}

function saveItem() {
  readForm();
  if (!editing.title) { $('tkTitle').focus(); toast('Donne un titre.'); return; }
  const { _new, ...item } = editing;
  upsert(item);
  if (item.date) { selDay = item.date; viewMonth = item.date.slice(0, 7); }
  editing = null;
  closeItem();
}
function closeItem() {
  editing = null;
  if (location.hash.slice(1) !== 'calendrier') location.hash = 'calendrier';
  else route();
}

// =====================================================================
// Écran Réviser : à faire aujourd'hui
// =====================================================================
// Panneau « Aujourd'hui » à droite sur les grands écrans : en retard et aujourd'hui, demain, DS et colles à venir.
export function renderTodayPanel(box) {
  const t = todayIso(), tom = addDays(t, 1);
  box.innerHTML = '<div class="tp-head"><h2>Aujourd\'hui</h2><a class="linklike" href="#calendrier">Calendrier</a></div>';
  const section = (title, items, showDate, empty) => {
    if (title) box.insertAdjacentHTML('beforeend', '<h3>' + title + '</h3>');
    if (!items.length) { if (empty) box.insertAdjacentHTML('beforeend', '<p class="tp-empty">' + empty + '</p>'); return; }
    const ul = document.createElement('ul');
    ul.className = 'ag-list';
    items.forEach((it) => ul.appendChild(row(it, showDate)));
    box.appendChild(ul);
  };
  const now = dueNow();
  section('', now, true, 'Rien à faire aujourd\'hui.');
  section('Demain', agenda.items.filter((it) => !it.done && it.date === tom).sort(compare), false, 'Rien de prévu.');
  section('DS et colles', upcomingExams().filter((it) => it.date !== tom), true, '');
}

export function renderTodo(container) {
  const items = dueNow();
  const exams = upcomingExams();
  container.innerHTML = '';
  container.hidden = !items.length && !exams.length;
  if (container.hidden) return;
  const t = todayIso();
  const head = document.createElement('div');
  head.className = 'todo-head';
  head.innerHTML = '<h2>À faire</h2><a class="linklike" href="#calendrier">Calendrier</a>';
  container.appendChild(head);
  const ul = document.createElement('ul');
  ul.className = 'ag-list';
  items.slice(0, 6).forEach((it) => ul.appendChild(row(it, it.date < t)));
  container.appendChild(ul);
  if (items.length > 6) container.insertAdjacentHTML('beforeend', '<p class="sub">Et ' + (items.length - 6) + ' de plus dans le calendrier.</p>');
  if (exams.length) {
    const p = document.createElement('div');
    p.className = 'todo-exams';
    exams.forEach((it) => {
      const line = document.createElement('div');
      line.className = 'todo-exam';
      const days = Math.round((parse(it.date) - parse(t)) / 86400000);
      line.innerHTML = '<span><b></b> ' + (days === 0 ? 'aujourd\'hui' : days === 1 ? 'demain' : 'dans ' + days + ' jours') + '</span>';
      line.querySelector('b').textContent = TYPES[it.type] + ' : ' + it.title;
      if ((it.chaps || []).length) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ghost small';
        b.textContent = 'Réviser';
        b.addEventListener('click', () => prepare(it));
        line.appendChild(b);
      }
      p.appendChild(line);
    });
    container.appendChild(p);
  }
}

// =====================================================================
// Événements
// =====================================================================
function newItem(fields) {
  return { id: newId(), title: '', type: 'devoir', mat: '', chaps: [], date: null, time: null, prio: 0, flag: false, notes: '', subs: [], done: false, created: Date.now(), ...fields };
}
function setCollapsed(v) {
  collapsed = v;
  writePref('fc.agCollapsed', v ? '1' : '0');
  if (!v) viewMonth = selDay.slice(0, 7);
  renderAgenda();
}
// Flèches et balayages : mois suivant (grille dépliée) ou semaine suivante (repliée).
function step(dir) {
  if (weekMode()) {
    selDay = addDays(selDay, 7 * dir);
  } else {
    viewMonth = shiftMonth(viewMonth, dir);
    const t = todayIso();
    selDay = viewMonth === t.slice(0, 7) ? t : viewMonth + '-01';
  }
  renderAgenda();
}

export function bindAgenda() {
  $('agToday').addEventListener('click', () => { selDay = todayIso(); viewMonth = selDay.slice(0, 7); scrollToSel = true; renderAgenda(); });
  $('agHideDone').addEventListener('click', () => { hideDone = !hideDone; renderAgenda(); });
  $('agPrev').addEventListener('click', () => step(-1));
  desk.addEventListener('change', () => { if (!$('view-calendrier').hidden) renderAgenda(); });
  $('agNext').addEventListener('click', () => step(1));
  document.querySelectorAll('#agMode button').forEach((b) => b.addEventListener('click', () => setCollapsed(b.dataset.mode === 'semaine')));
  // Barre d'ajout en bas : ajoute au jour sélectionné.
  const addQuick = () => {
    const title = $('agQuickInput').value.trim();
    if (!title) return null;
    const item = newItem({ title, type: guessType(title), mat: guessMatiere(title), date: selDay });
    upsert(item);
    $('agQuickInput').value = '';
    renderAgenda();
    return item;
  };
  $('agQuickInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (addQuick()) toast('Ajouté.'); } });
  $('agQuickInfo').addEventListener('click', () => {
    const made = addQuick();
    openItem(made || newItem({ date: selDay }), !made);
  });
  // Gestes sur la grille : vertical = replier / déplier, horizontal = mois ou semaine suivante.
  let g = null;
  $('agCal').addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { g = null; return; }
    g = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  }, { passive: true });
  $('agCal').addEventListener('touchend', (e) => {
    if (!g) return;
    const dx = e.changedTouches[0].clientX - g.x, dy = e.changedTouches[0].clientY - g.y;
    const fast = Date.now() - g.t < 700;
    g = null;
    if (!fast) return;
    if (Math.abs(dy) > 40 && Math.abs(dy) > 1.5 * Math.abs(dx)) setCollapsed(dy < 0);
    else if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
  }, { passive: true });
  // Balayage horizontal sur la liste : semaine précédente / suivante.
  let start = null;
  $('agWeek').addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || e.target.closest('input, textarea')) { start = null; return; }
    start = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  }, { passive: true });
  $('agWeek').addEventListener('touchend', (e) => {
    if (!start) return;
    const dx = e.changedTouches[0].clientX - start.x, dy = e.changedTouches[0].clientY - start.y;
    const ok = Date.now() - start.t < 600 && Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy);
    start = null;
    if (ok) { selDay = addDays(selDay, dx < 0 ? 7 : -7); viewMonth = selDay.slice(0, 7); renderAgenda(); }
  }, { passive: true });

  // Fiche
  $('tkBack').addEventListener('click', closeItem);
  $('tkSave').addEventListener('click', saveItem);
  $('tkTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveItem(); } });
  document.querySelectorAll('#tkTypes button').forEach((b) => b.addEventListener('click', () => {
    editing.type = b.dataset.type;
    document.querySelectorAll('#tkTypes button').forEach((x) => x.classList.toggle('on', x === b));
    updatePrep();
  }));
  document.querySelectorAll('#tkPrio button').forEach((b) => b.addEventListener('click', () => {
    editing.prio = Number(b.dataset.p);
    document.querySelectorAll('#tkPrio button').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('tkHasDate').addEventListener('change', () => {
    $('tkDateBox').hidden = !$('tkHasDate').checked;
    $('tkTimeRow').hidden = !$('tkHasDate').checked;
  });
  $('tkHasTime').addEventListener('change', () => { $('tkTime').hidden = !$('tkHasTime').checked; });
  $('tkMat').addEventListener('change', () => {
    editing.mat = $('tkMat').value;
    editing.chaps = editing.chaps.filter((id) => { const c = state.byId.get(id); return c && c.matiere === editing.mat; });
    renderChaps();
    updatePrep();
  });
  $('tkSubNew').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = $('tkSubNew').value.trim();
    if (!text) return;
    editing.subs.push({ id: newId(), text, done: false });
    $('tkSubNew').value = '';
    renderSubs();
  });
  $('tkSubAdd').addEventListener('click', () => {
    const text = $('tkSubNew').value.trim();
    if (!text) { $('tkSubNew').focus(); return; }
    editing.subs.push({ id: newId(), text, done: false });
    $('tkSubNew').value = '';
    renderSubs();
    $('tkSubNew').focus();
  });
  $('tkPrepBtn').addEventListener('click', () => { readForm(); const it = { ...editing }; prepare(it); });
  $('tkDelete').addEventListener('click', () => { $('tkDeleteConfirm').hidden = false; });
  $('tkDeleteNo').addEventListener('click', () => { $('tkDeleteConfirm').hidden = true; });
  $('tkDeleteYes').addEventListener('click', () => { remove(editing.id); toast('Supprimé.'); closeItem(); });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAgenda();
    else if (canSync()) loadAgenda().then(() => { if (!$('view-calendrier').hidden) renderAgenda(); });
  });
}
