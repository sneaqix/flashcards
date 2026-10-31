// Progression, paramètres, journal quotidien et file de révision.
import * as F from './scheduler.js?v=20261031224745';

export { today, addDays, daysBetween, BUCKETS, bucketOf, formatDays } from './scheduler.js?v=20261031224745';

const LS_PROGRESS = 'fc.progress.v2';
const LS_CONFIG = 'fc.config.v1';
const LS_DEVICE = 'fc.device';

// newPerDay et maxReviews servent de valeurs par défaut pour une matière sans réglage propre.
// subjects : { matiere: { newPerDay, maxReviews } } ; maxReviews = 0 signifie sans limite.
export const DEFAULT_SETTINGS = {
  newPerDay: 10, maxReviews: 100, subjects: {}, inactive: [], updated: 0,
  ...F.DEFAULT_SCHEDULING,
};

export function subjectLimits(settings, mat) {
  const s = (settings.subjects || {})[mat] || {};
  return {
    newPerDay: Number.isFinite(s.newPerDay) ? s.newPerDay : settings.newPerDay,
    maxReviews: Number.isFinite(s.maxReviews) ? s.maxReviews : settings.maxReviews,
  };
}

// ---------- Stockage local ----------
function readLS(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
}
function writeLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
}

export function deviceId() {
  let id = null;
  try { id = localStorage.getItem(LS_DEVICE); } catch (e) { /* indisponible */ }
  if (!id) {
    id = 'app-' + Math.random().toString(36).slice(2, 8);
    try { localStorage.setItem(LS_DEVICE, id); } catch (e) { /* indisponible */ }
  }
  return id;
}

export function emptyProgress() {
  return { version: 3, cards: {}, logs: {}, settings: { ...DEFAULT_SETTINGS } };
}

export function normalize(p) {
  const base = emptyProgress();
  if (!p || typeof p !== 'object') return base;
  const cards = {};
  Object.entries(p.cards && typeof p.cards === 'object' ? p.cards : {}).forEach(([k, st]) => {
    if (st) cards[k] = F.migrateCard(st);
  });
  return {
    version: 3,
    cards,
    logs: p.logs && typeof p.logs === 'object' ? p.logs : {},
    settings: { ...DEFAULT_SETTINGS, ...(p.settings || {}) },
  };
}

export function loadProgress() { return normalize(readLS(LS_PROGRESS)); }
export function saveProgress(p) { return writeLS(LS_PROGRESS, p); }

// Configuration propre à l'appareil (jeton et dépôts) : jamais synchronisée.
export function loadConfig() {
  return { token: '', contentRepo: '', dataRepo: '', lastSync: 0, ...(readLS(LS_CONFIG) || {}) };
}
export function saveConfig(c) { writeLS(LS_CONFIG, c); }

// ---------- Fusion de deux progressions (PC et téléphone) ----------
// Cartes : on garde l'état le plus récent. Journaux : un par appareil, on garde la version la plus récente.
export function merge(a, b) {
  a = normalize(a); b = normalize(b);
  const out = emptyProgress();
  const keys = new Set([...Object.keys(a.cards), ...Object.keys(b.cards)]);
  keys.forEach((k) => {
    const x = a.cards[k], y = b.cards[k];
    out.cards[k] = !x ? y : !y ? x : ((y.last || 0) > (x.last || 0) ? y : x);
  });
  const devices = new Set([...Object.keys(a.logs), ...Object.keys(b.logs)]);
  devices.forEach((dev) => {
    const la = a.logs[dev] || {}, lb = b.logs[dev] || {};
    const days = {};
    new Set([...Object.keys(la), ...Object.keys(lb)]).forEach((day) => {
      const x = la[day], y = lb[day];
      if (!x || !y) { days[day] = x || y; return; }
      // Même appareil : la version la plus récente a le compteur de modifications `s` le plus grand
      // (à défaut, le plus de réponses). `s` augmente aussi quand on annule une réponse.
      const sx = x.s ?? x.r ?? 0, sy = y.s ?? y.r ?? 0;
      days[day] = sy > sx ? y : x;
    });
    out.logs[dev] = days;
  });
  out.settings = (b.settings.updated || 0) > (a.settings.updated || 0) ? b.settings : a.settings;
  return out;
}

// Sérialisation stable (clés triées) pour comparer deux progressions.
export function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

// ---------- Journal quotidien ----------
// Par appareil et par jour :
//   r réponses, c réponses autres que « À revoir », n nouvelles cartes, v cartes en révision vues,
//   t temps passé (ms), g répartition des 4 boutons, rv [révisions, réussies] pour la rétention,
//   m { matière: [réponses, justes] }, mn { matière: [nouvelles, révisions] }, mt { matière: temps },
//   s compteur de modifications (pour la fusion).
function emptyLog() {
  return { r: 0, c: 0, n: 0, v: 0, t: 0, g: [0, 0, 0, 0], rv: [0, 0], m: {}, mn: {}, mt: {}, s: 0 };
}
function dayLog(p, dev, day) {
  p.logs[dev] = p.logs[dev] || {};
  const old = p.logs[dev][day];
  const l = { ...emptyLog(), ...(old || {}) };
  if (old && old.s == null) l.s = old.r || 0;
  p.logs[dev][day] = l;
  return l;
}

// Totaux d'une journée, tous appareils confondus.
export function dayTotals(p, day) {
  const t = emptyLog();
  const addMap = (target, src, size) => Object.entries(src || {}).forEach(([k, v]) => {
    if (size) {
      target[k] = target[k] || new Array(size).fill(0);
      v.forEach((x, i) => { target[k][i] += x || 0; });
    } else target[k] = (target[k] || 0) + (v || 0);
  });
  Object.values(p.logs).forEach((days) => {
    const l = days[day];
    if (!l) return;
    ['r', 'c', 'n', 'v', 't'].forEach((k) => { t[k] += l[k] || 0; });
    (l.g || []).forEach((x, i) => { t.g[i] += x || 0; });
    (l.rv || []).forEach((x, i) => { t.rv[i] += x || 0; });
    addMap(t.m, l.m, 2);
    addMap(t.mn, l.mn, 2);
    addMap(t.mt, l.mt, 0);
  });
  return t;
}

// ---------- Cartes et faces ----------
// Une carte « inversée » donne deux faces à réviser : question → réponse et réponse → question.
export function faces(ch) {
  const out = [];
  ch.cartes.forEach((card) => {
    out.push({ chapter: ch, card, rev: false, key: ch.id + '/' + card.id });
    if (card.inverse && card.mode !== 'trou') out.push({ chapter: ch, card, rev: true, key: ch.id + '/' + card.id + '~r' });
  });
  return out;
}
export function cardKey(chapter, card, rev = false) {
  return chapter.id + '/' + card.id + (rev ? '~r' : '');
}
// État d'une face, ou null si elle n'a jamais été vue.
export function stateOf(p, key) {
  const st = p.cards[key];
  return st && st.state && st.state !== 'new' ? st : null;
}

export function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Cartes à faire aujourd'hui dans les chapitres donnés, en respectant les limites de chaque matière.
// Les cartes en cours d'apprentissage (revues dans la journée) ne sont pas limitées.
// Renvoie { items, learn, reviewsDue, newAvailable, bySubject } ; items est mélangé.
export function dailyQueue(p, chapters) {
  const day = F.today();
  const t = dayTotals(p, day);
  const groups = new Map(); // matière -> { learn, reviews, fresh }
  chapters.forEach((ch) => {
    if (!groups.has(ch.matiere)) groups.set(ch.matiere, { learn: [], reviews: [], fresh: [] });
    const g = groups.get(ch.matiere);
    faces(ch).forEach((f, pos) => {
      const st = stateOf(p, f.key);
      if (!st) g.fresh.push({ ...f, kind: 'new', pos });
      else if (st.state !== 'review') g.learn.push({ ...f, kind: 'learn' });
      else if (st.due <= day) g.reviews.push({ ...f, kind: 'review' });
    });
  });
  const items = [];
  const bySubject = {};
  let reviewsDue = 0, newAvailable = 0, learn = 0;
  groups.forEach((g, mat) => {
    const lim = subjectLimits(p.settings, mat);
    const [doneNew, doneRev] = t.mn[mat] || [0, 0];
    const reviewLimit = lim.maxReviews > 0 ? Math.max(0, lim.maxReviews - doneRev) : Infinity;
    const newLimit = Math.max(0, lim.newPerDay - doneNew);
    const rev = shuffle(g.reviews).slice(0, reviewLimit);
    // Nouvelles cartes dans l'ordre des chapitres (les plus utiles d'abord), en alternant entre chapitres.
    const fresh = g.fresh.slice().sort((a, b) => a.pos - b.pos).slice(0, newLimit);
    items.push(...g.learn, ...rev, ...fresh);
    bySubject[mat] = { reviews: rev.length, fresh: fresh.length, learn: g.learn.length, total: rev.length + fresh.length + g.learn.length };
    reviewsDue += rev.length;
    newAvailable += fresh.length;
    learn += g.learn.length;
  });
  return { items: shuffle(items), reviewsDue, newAvailable, learn, bySubject };
}

// ---------- Planificateur d'examen (DS et colles du calendrier) ----------
// Objectif : toutes les faces des chapitres du DS découvertes avant les 3 derniers jours,
// puis chacune revue au moins une fois pendant ces 3 derniers jours.
// exams : [{ id, title, type, date: 'AAAA-MM-JJ', chaps: [ids] }] ; byId : Map id -> chapitre.
export const EXAM_WINDOW = 3;
export function examPlan(p, exams, byId, day = F.today()) {
  const plans = [];
  const taken = new Set();
  const sorted = exams.filter((e) => e && e.date && (e.chaps || []).length && F.daysBetween(day, e.date) >= 1)
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const ex of sorted) {
    const n = F.daysBetween(day, ex.date); // jours restants avant le DS (le jour J n'est pas compté)
    const chs = ex.chaps.map((id) => byId.get(id)).filter(Boolean);
    const faces = chs.flatMap((ch) => faces_(ch)).filter((f) => !taken.has(f.key));
    faces.forEach((f) => taken.add(f.key));
    const fresh = [], introducedToday = [], pending = [], doneToday = [];
    const windowStart = F.addDays(ex.date, -EXAM_WINDOW);
    faces.forEach((f) => {
      const st = stateOf(p, f.key);
      if (!st) { fresh.push(f); return; }
      if (st.fd === day) introducedToday.push(f);
      if (n <= EXAM_WINDOW && st.state === 'review') {
        if (st.lastDay === day) doneToday.push(f);
        else if (!st.lastDay || st.lastDay < windowStart) pending.push({ f, st });
      }
    });
    // Nouvelles faces : réparties sur les jours avant la fenêtre finale (ou sur les jours restants).
    const daysForNew = n > EXAM_WINDOW ? n - EXAM_WINDOW : n;
    const newTarget = Math.ceil((fresh.length + introducedToday.length) / daysForNew);
    const newToday = Math.max(0, Math.min(fresh.length, newTarget - introducedToday.length));
    // Dernière revue : les faces pas encore revues pendant la fenêtre, réparties sur les jours restants.
    let recheck = [];
    if (n <= EXAM_WINDOW) {
      const target = Math.ceil((pending.length + doneToday.length) / n);
      const k = Math.max(0, Math.min(pending.length, target - doneToday.length));
      recheck = pending.sort((a, b) => (a.st.due || '').localeCompare(b.st.due || '')).slice(0, k).map((x) => x.f);
    }
    const items = [
      ...fresh.slice(0, newToday).map((f) => ({ ...f, kind: 'new', exam: ex.id })),
      ...recheck.map((f) => ({ ...f, kind: 'review', exam: ex.id })),
    ];
    plans.push({ exam: ex, daysLeft: n, items, freshLeft: fresh.length, pendingLeft: pending.length, total: faces.length, final: n <= EXAM_WINDOW });
  }
  return plans;
}
const faces_ = (ch) => faces(ch);

// File de la « Révision du jour » avec la préparation des DS : les faces du planificateur
// s'ajoutent à la file normale (sans compter dans les limites quotidiennes des matières).
export function dailyWithExams(p, chapters, exams, byId) {
  const q = dailyQueue(p, chapters);
  const plans = examPlan(p, exams || [], byId);
  const have = new Set(q.items.map((it) => it.key));
  let extra = 0;
  plans.forEach((pl) => {
    pl.added = 0;
    pl.items.forEach((it) => {
      if (have.has(it.key)) return;
      have.add(it.key);
      q.items.push(it);
      pl.added++;
      extra++;
    });
  });
  if (extra) shuffle(q.items);
  q.plans = plans;
  q.extra = extra;
  return q;
}

// Enregistre une réponse (g de 1 à 4). `first` : premier passage de cette face dans la session.
// `ms` : temps passé sur la carte. Renvoie de quoi annuler cette réponse avec undoAnswer.
export function recordAnswer(p, item, g, first, ms = 0, now = Date.now()) {
  const key = item.key;
  const day = F.today(now);
  const dev = deviceId();
  const undo = {
    key, day, dev,
    prevCard: p.cards[key] ? { ...p.cards[key] } : null,
    prevLog: p.logs[dev] && p.logs[dev][day] ? JSON.parse(JSON.stringify(p.logs[dev][day])) : null,
  };
  const prev = stateOf(p, key);
  p.cards[key] = F.schedule(prev, g, now, p.settings, key);
  // Jour de découverte de la face (sert au planificateur d'examen).
  const fd = prev ? prev.fd : day;
  if (fd) p.cards[key].fd = fd;

  const l = dayLog(p, dev, day);
  const mat = item.chapter.matiere;
  const time = Math.min(Math.max(0, ms), 60000); // au-delà d'une minute, on considère une pause
  l.s = (l.s ?? l.r) + 1;
  l.r++;
  if (g > 1) l.c++;
  l.g[g - 1]++;
  l.t += time;
  l.mt[mat] = (l.mt[mat] || 0) + time;
  if (prev && prev.state === 'review') { l.rv[0]++; if (g > 1) l.rv[1]++; }
  if (first && (item.kind === 'new' || item.kind === 'review')) {
    l.mn[mat] = l.mn[mat] || [0, 0];
    if (item.kind === 'new') { l.n++; l.mn[mat][0]++; } else { l.v++; l.mn[mat][1]++; }
  }
  l.m[mat] = l.m[mat] || [0, 0];
  l.m[mat][0]++;
  if (g > 1) l.m[mat][1]++;
  return undo;
}

// Annule une réponse : la carte et le journal du jour reviennent à leur état d'avant.
// Les dates `last` et le compteur `s` avancent pour que l'annulation l'emporte à la synchronisation.
export function undoAnswer(p, undo) {
  const now = Date.now();
  p.cards[undo.key] = undo.prevCard ? { ...undo.prevCard, last: now } : { state: 'new', last: now };
  const cur = p.logs[undo.dev] && p.logs[undo.dev][undo.day];
  const s = cur ? (cur.s ?? cur.r ?? 0) : 0;
  p.logs[undo.dev] = p.logs[undo.dev] || {};
  p.logs[undo.dev][undo.day] = { ...(undo.prevLog || emptyLog()), s: s + 1 };
}

// Intervalles proposés par les 4 boutons pour une face.
export function previews(p, item, now = Date.now()) {
  return F.previewAll(stateOf(p, item.key), now, p.settings, item.key).map((next) => F.formatDelay(next, now));
}
