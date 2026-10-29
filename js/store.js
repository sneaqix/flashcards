// Progression, paramètres et logique de répétition espacée (boîtes de Leitner).

export const INTERVALS = [1, 2, 4, 8, 16]; // jours d'attente après une réussite, boîtes 1 à 5
const LS_PROGRESS = 'fc.progress.v2';
const LS_CONFIG = 'fc.config.v1';
const LS_DEVICE = 'fc.device';

// newPerDay et maxReviews servent de valeurs par défaut pour une matière sans réglage propre.
// subjects : { matiere: { newPerDay, maxReviews } } ; maxReviews = 0 signifie sans limite.
export const DEFAULT_SETTINGS = { newPerDay: 10, maxReviews: 100, subjects: {}, inactive: [], updated: 0 };

export function subjectLimits(settings, mat) {
  const s = (settings.subjects || {})[mat] || {};
  return {
    newPerDay: Number.isFinite(s.newPerDay) ? s.newPerDay : settings.newPerDay,
    maxReviews: Number.isFinite(s.maxReviews) ? s.maxReviews : settings.maxReviews,
  };
}

// ---------- Dates (jour local au format AAAA-MM-JJ) ----------
export function iso(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
export function today() { return iso(new Date()); }
export function inDays(n, from = new Date()) {
  const d = new Date(from); d.setDate(d.getDate() + n); return iso(d);
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
  return { version: 2, cards: {}, logs: {}, settings: { ...DEFAULT_SETTINGS } };
}

export function normalize(p) {
  const base = emptyProgress();
  if (!p || typeof p !== 'object') return base;
  return {
    version: 2,
    cards: p.cards && typeof p.cards === 'object' ? p.cards : {},
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
// Cartes : on garde l'état le plus récent. Journaux : un par appareil, on garde le maximum.
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
function dayLog(p, dev, day) {
  p.logs[dev] = p.logs[dev] || {};
  p.logs[dev][day] = p.logs[dev][day] || { r: 0, c: 0, n: 0, v: 0, m: {}, mn: {} };
  const l = p.logs[dev][day];
  l.m = l.m || {};
  l.mn = l.mn || {};
  return l;
}

// Totaux d'une journée, tous appareils confondus.
export function dayTotals(p, day) {
  // m : réponses par matière [réponses, justes] ; mn : cartes faites par matière [nouvelles, révisions]
  const t = { r: 0, c: 0, n: 0, v: 0, m: {}, mn: {} };
  Object.values(p.logs).forEach((days) => {
    const l = days[day];
    if (!l) return;
    t.r += l.r || 0; t.c += l.c || 0; t.n += l.n || 0; t.v += l.v || 0;
    Object.entries(l.m || {}).forEach(([mat, [r, c]]) => {
      t.m[mat] = t.m[mat] || [0, 0];
      t.m[mat][0] += r; t.m[mat][1] += c;
    });
    Object.entries(l.mn || {}).forEach(([mat, [n, v]]) => {
      t.mn[mat] = t.mn[mat] || [0, 0];
      t.mn[mat][0] += n; t.mn[mat][1] += v;
    });
  });
  return t;
}

// ---------- Révision ----------
export const cardKey = (chapter, card) => chapter.id + '/' + card.id;

export function cardState(p, chapter, card) {
  const st = p.cards[cardKey(chapter, card)];
  return st && st.box > 0 ? st : null; // null = carte jamais vue (box 0 : réponse annulée sur une nouvelle carte)
}

export function isDue(state, day = today()) {
  return !state || state.due <= day;
}

export function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Cartes à faire aujourd'hui dans les chapitres donnés, en respectant les limites quotidiennes
// de chaque matière (les chapitres portent leur matière dans `matiere`).
// Renvoie { items, reviewsDue, newAvailable, bySubject } ; items est mélangé.
export function dailyQueue(p, chapters) {
  const day = today();
  const t = dayTotals(p, day);
  const groups = new Map(); // matière -> { reviews, fresh }
  chapters.forEach((ch) => {
    if (!groups.has(ch.matiere)) groups.set(ch.matiere, { reviews: [], fresh: [] });
    const g = groups.get(ch.matiere);
    ch.cartes.forEach((card) => {
      const st = cardState(p, ch, card);
      if (!st) g.fresh.push({ chapter: ch, card, isNew: true });
      else if (st.due <= day) g.reviews.push({ chapter: ch, card, isNew: false });
    });
  });
  const items = [];
  const bySubject = {};
  let reviewsDue = 0, newAvailable = 0;
  groups.forEach((g, mat) => {
    const lim = subjectLimits(p.settings, mat);
    const [doneNew, doneRev] = t.mn[mat] || [0, 0];
    const reviewLimit = lim.maxReviews > 0 ? Math.max(0, lim.maxReviews - doneRev) : Infinity;
    const newLimit = Math.max(0, lim.newPerDay - doneNew);
    const rev = shuffle(g.reviews).slice(0, reviewLimit);
    const fresh = shuffle(g.fresh).slice(0, newLimit);
    items.push(...rev, ...fresh);
    bySubject[mat] = { reviews: rev.length, fresh: fresh.length, total: rev.length + fresh.length };
    reviewsDue += rev.length;
    newAvailable += fresh.length;
  });
  return { items: shuffle(items), reviewsDue, newAvailable, bySubject };
}

// Enregistre une réponse. `first` : premier passage de cette carte dans la session.
// Renvoie de quoi annuler cette réponse avec undoAnswer.
export function recordAnswer(p, item, knew, first) {
  const key = cardKey(item.chapter, item.card);
  const day = today();
  const dev = deviceId();
  const undo = {
    key, day, dev,
    prevCard: p.cards[key] ? { ...p.cards[key] } : null,
    prevLog: p.logs[dev] && p.logs[dev][day] ? JSON.parse(JSON.stringify(p.logs[dev][day])) : null,
  };
  const prev = p.cards[key] || { box: 0, n: 0, l: 0 };
  const now = Date.now();
  if (knew) {
    const box = Math.min(5, (prev.box || 0) + 1);
    p.cards[key] = { box, due: inDays(INTERVALS[box - 1]), last: now, n: (prev.n || 0) + 1, l: prev.l || 0 };
  } else {
    p.cards[key] = { box: 1, due: today(), last: now, n: (prev.n || 0) + 1, l: (prev.l || 0) + 1 };
  }
  const l = dayLog(p, dev, day);
  l.s = (l.s ?? l.r) + 1;
  l.r++;
  if (knew) l.c++;
  const mat = item.chapter.matiere;
  if (first) {
    l.mn[mat] = l.mn[mat] || [0, 0];
    if (item.isNew) { l.n++; l.mn[mat][0]++; } else { l.v++; l.mn[mat][1]++; }
  }
  l.m[mat] = l.m[mat] || [0, 0];
  l.m[mat][0]++;
  if (knew) l.m[mat][1]++;
  return undo;
}

// Annule une réponse : la carte et le journal du jour reviennent à leur état d'avant.
// Les dates `last` et le compteur `s` avancent pour que l'annulation l'emporte à la synchronisation.
export function undoAnswer(p, undo) {
  const now = Date.now();
  p.cards[undo.key] = undo.prevCard
    ? { ...undo.prevCard, last: now }
    : { box: 0, due: null, last: now, n: 0, l: 0 };
  const cur = p.logs[undo.dev] && p.logs[undo.dev][undo.day];
  const s = cur ? (cur.s ?? cur.r ?? 0) : 0;
  p.logs[undo.dev] = p.logs[undo.dev] || {};
  p.logs[undo.dev][undo.day] = { ...(undo.prevLog || { r: 0, c: 0, n: 0, v: 0, m: {}, mn: {} }), s: s + 1 };
}
