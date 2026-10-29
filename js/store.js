// Progression, paramètres et logique de répétition espacée (boîtes de Leitner).

export const INTERVALS = [1, 2, 4, 8, 16]; // jours d'attente après une réussite, boîtes 1 à 5
const LS_PROGRESS = 'fc.progress.v2';
const LS_CONFIG = 'fc.config.v1';
const LS_DEVICE = 'fc.device';

export const DEFAULT_SETTINGS = { newPerDay: 10, maxReviews: 100, inactive: [], updated: 0 };

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
      days[day] = (y.r || 0) > (x.r || 0) ? y : x; // même appareil : la version avec le plus de réponses est la plus récente
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
  p.logs[dev][day] = p.logs[dev][day] || { r: 0, c: 0, n: 0, v: 0, m: {} };
  const l = p.logs[dev][day];
  l.m = l.m || {};
  return l;
}

// Totaux d'une journée, tous appareils confondus.
export function dayTotals(p, day) {
  const t = { r: 0, c: 0, n: 0, v: 0, m: {} };
  Object.values(p.logs).forEach((days) => {
    const l = days[day];
    if (!l) return;
    t.r += l.r || 0; t.c += l.c || 0; t.n += l.n || 0; t.v += l.v || 0;
    Object.entries(l.m || {}).forEach(([mat, [r, c]]) => {
      t.m[mat] = t.m[mat] || [0, 0];
      t.m[mat][0] += r; t.m[mat][1] += c;
    });
  });
  return t;
}

// ---------- Révision ----------
export const cardKey = (chapter, card) => chapter.id + '/' + card.id;

export function cardState(p, chapter, card) {
  return p.cards[cardKey(chapter, card)] || null; // null = carte jamais vue
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

// Cartes à faire aujourd'hui dans les chapitres donnés, en respectant les limites quotidiennes.
// Renvoie { items, reviewsDue, newAvailable } ; items est mélangé.
export function dailyQueue(p, chapters) {
  const day = today();
  const t = dayTotals(p, day);
  const s = p.settings;
  const reviews = [], fresh = [];
  chapters.forEach((ch) => ch.cartes.forEach((card) => {
    const st = cardState(p, ch, card);
    if (!st) fresh.push({ chapter: ch, card, isNew: true });
    else if (st.due <= day) reviews.push({ chapter: ch, card, isNew: false });
  }));
  shuffle(reviews); shuffle(fresh);
  const reviewLimit = s.maxReviews > 0 ? Math.max(0, s.maxReviews - t.v) : Infinity;
  const newLimit = Math.max(0, s.newPerDay - t.n);
  const items = shuffle([...reviews.slice(0, reviewLimit), ...fresh.slice(0, newLimit)]);
  return { items, reviewsDue: Math.min(reviews.length, reviewLimit), newAvailable: Math.min(fresh.length, newLimit) };
}

// Enregistre une réponse. `first` : premier passage de cette carte dans la session.
export function recordAnswer(p, item, knew, first) {
  const key = cardKey(item.chapter, item.card);
  const prev = p.cards[key] || { box: 0, n: 0, l: 0 };
  const now = Date.now();
  if (knew) {
    const box = Math.min(5, (prev.box || 0) + 1);
    p.cards[key] = { box, due: inDays(INTERVALS[box - 1]), last: now, n: (prev.n || 0) + 1, l: prev.l || 0 };
  } else {
    p.cards[key] = { box: 1, due: today(), last: now, n: (prev.n || 0) + 1, l: (prev.l || 0) + 1 };
  }
  const l = dayLog(p, deviceId(), today());
  l.r++;
  if (knew) l.c++;
  if (first) { if (item.isNew) l.n++; else l.v++; }
  const mat = item.chapter.matiere;
  l.m[mat] = l.m[mat] || [0, 0];
  l.m[mat][0]++;
  if (knew) l.m[mat][1]++;
}
