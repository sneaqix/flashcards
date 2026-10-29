// Planification des révisions : étapes d'apprentissage dans la journée, puis algorithme FSRS (version 4.5).
//
// FSRS estime pour chaque carte :
//   - sa stabilité S : nombre de jours au bout duquel la probabilité de s'en souvenir tombe à 90 % ;
//   - sa difficulté D, de 1 (facile) à 10 (difficile).
// L'intervalle suivant est choisi pour que la probabilité de se souvenir au moment de la révision
// soit égale à la rétention visée (90 % par défaut). Les intervalles grandissent donc sans plafond fixe.
//
// Notes : 1 = À revoir, 2 = Difficile, 3 = Correct, 4 = Facile.

// Paramètres par défaut de FSRS-4.5, issus de l'optimisation sur de nombreux utilisateurs d'Anki.
const W = [0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234, 1.616, 0.1544,
  1.0824, 1.9813, 0.0953, 0.2975, 2.2042, 0.2407, 2.9466];
const DECAY = -0.5;
const FACTOR = 19 / 81; // 0.9^(1/DECAY) - 1
const MINUTE = 60000;

export const DEFAULT_SCHEDULING = {
  retention: 0.9,        // probabilité visée de se souvenir d'une carte au moment de la revoir
  maxIvl: 365,           // intervalle maximum en jours
  learnSteps: [1, 10],   // étapes d'apprentissage d'une nouvelle carte, en minutes
  relearnSteps: [10],    // étapes après un oubli, en minutes
};

// ---------- Jours (la journée de révision change à 4 h du matin) ----------
const ROLLOVER_H = 4;
function isoOf(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
export function dayOf(ms) { return isoOf(new Date(ms - ROLLOVER_H * 3600000)); }
export function today(now = Date.now()) { return dayOf(now); }
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return isoOf(new Date(y, m - 1, d + n, 12));
}
export function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// ---------- Formules FSRS ----------
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export function retrievability(elapsedDays, S) {
  return Math.pow(1 + FACTOR * elapsedDays / S, DECAY);
}
function ivlFor(S, retention) {
  return S / FACTOR * (Math.pow(retention, 1 / DECAY) - 1);
}
function initS(g) { return W[g - 1]; }
function initD(g) { return clamp(W[4] - (g - 3) * W[5], 1, 10); }
function nextD(D, g) {
  return clamp(W[7] * initD(3) + (1 - W[7]) * (D - W[6] * (g - 3)), 1, 10);
}
function recallS(D, S, R, g) {
  const hard = g === 2 ? W[15] : 1;
  const easy = g === 4 ? W[16] : 1;
  return S * (1 + Math.exp(W[8]) * (11 - D) * Math.pow(S, -W[9]) * (Math.exp(W[10] * (1 - R)) - 1) * hard * easy);
}
function forgetS(D, S, R) {
  return Math.min(S, W[11] * Math.pow(D, -W[12]) * (Math.pow(S + 1, W[13]) - 1) * Math.exp(W[14] * (1 - R)));
}

// Petite variation aléatoire (mais reproductible) des intervalles pour étaler la charge entre les jours.
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}
function fuzz(ivl, seed) {
  if (ivl < 3) return ivl;
  const delta = Math.max(1, Math.round(ivl * 0.05));
  return ivl + Math.round((hash(seed) * 2 - 1) * delta);
}

function settingsOf(s) {
  const o = { ...DEFAULT_SCHEDULING, ...(s || {}) };
  o.retention = clamp(Number(o.retention) || 0.9, 0.7, 0.97);
  o.maxIvl = clamp(Math.round(Number(o.maxIvl) || 365), 7, 36500);
  if (!Array.isArray(o.learnSteps)) o.learnSteps = DEFAULT_SCHEDULING.learnSteps;
  if (!Array.isArray(o.relearnSteps)) o.relearnSteps = DEFAULT_SCHEDULING.relearnSteps;
  return o;
}

// Jours écoulés pris en compte. Si une carte à court intervalle (j1, j2) a été révisée en retard,
// on fait comme si elle l'avait été à l'heure : tout se décale simplement d'autant de jours.
function effectiveElapsed(st, day) {
  const real = Math.max(0, st.lastDay ? daysBetween(st.lastDay, day) : st.ivl || 0);
  return st.ivl <= 2 ? Math.min(real, st.ivl) : real;
}

function reviewIvl(S, cfg, seed) {
  return clamp(fuzz(Math.max(1, Math.round(ivlFor(S, cfg.retention))), seed), 1, cfg.maxIvl);
}

// ---------- Calcul du nouvel état d'une carte ----------
// st : état actuel (null pour une carte jamais vue). Renvoie le nouvel état sans modifier st.
export function schedule(st, g, now, settings, seedKey = '') {
  const cfg = settingsOf(settings);
  const day = today(now);
  const n = ((st && st.n) || 0) + 1;
  const l = (st && st.l) || 0;
  const base = { n, l, last: now, lastFail: st && st.lastFail };
  const seed = seedKey + ':' + n;
  const isNew = !st || !st.state || st.state === 'new';

  const graduate = (S, D, ivl) => ({ ...base, state: 'review', S, D, ivl, due: addDays(day, ivl), lastDay: day, step: 0 });
  const learn = (kind, S, D, step, delayMin) => ({ ...base, state: kind, S, D, step, ivl: st && st.ivl || 0,
    dueAt: now + Math.round(delayMin * MINUTE), due: day, lastDay: day });

  if (isNew || st.state === 'learning' || st.state === 'relearning') {
    const kind = isNew ? 'learning' : st.state;
    const steps = kind === 'learning' ? cfg.learnSteps : cfg.relearnSteps;
    let S = isNew ? initS(g) : st.S;
    let D = isNew ? initD(g) : nextD(st.D, g);
    const step = isNew ? 0 : st.step || 0;
    if (!isNew && g === 1) S = Math.min(S, kind === 'learning' ? W[0] : S);
    if (g === 4) {
      // Facile : la carte sort tout de suite de l'apprentissage.
      if (isNew) S = initS(4); else S = Math.max(S, W[2]);
      const goodIvl = Math.max(1, Math.round(ivlFor(st && st.S ? st.S : initS(3), cfg.retention)));
      return graduate(S, D, clamp(Math.max(reviewIvl(S, cfg, seed), goodIvl + 1), 1, cfg.maxIvl));
    }
    if (!steps.length) return graduate(S, D, g === 1 ? 1 : reviewIvl(S, cfg, seed));
    if (g === 1) return learn(kind, S, D, 0, steps[0]);
    if (g === 2) {
      const delay = step === 0 && steps.length > 1 ? (steps[0] + steps[1]) / 2 : steps[step] * (step === 0 ? 1.5 : 1);
      return learn(kind, S, D, step, delay);
    }
    // Correct : étape suivante, ou sortie de l'apprentissage après la dernière.
    const nextStep = isNew ? (steps.length > 1 ? 1 : steps.length) : step + 1;
    if (nextStep < steps.length) return learn(kind, S, D, nextStep, steps[nextStep]);
    const ivl = kind === 'relearning' ? Math.max(1, Math.round(ivlFor(S, cfg.retention))) : reviewIvl(S, cfg, seed);
    return graduate(S, D, clamp(ivl, 1, cfg.maxIvl));
  }

  // Carte en révision.
  const t = effectiveElapsed(st, day);
  const R = retrievability(t, st.S);
  const D = nextD(st.D, g);
  if (g === 1) {
    const S = forgetS(st.D, st.S, R);
    const lapse = { ...base, l: l + 1, lastFail: now };
    if (!cfg.relearnSteps.length) return { ...lapse, state: 'review', S, D, ivl: 1, due: addDays(day, 1), lastDay: day, step: 0 };
    return { ...lapse, state: 'relearning', S, D, step: 0, ivl: st.ivl, dueAt: now + cfg.relearnSteps[0] * MINUTE, due: day, lastDay: day };
  }
  // On calcule les trois intervalles pour garantir Difficile < Correct < Facile.
  const sH = recallS(st.D, st.S, R, 2), sG = recallS(st.D, st.S, R, 3), sE = recallS(st.D, st.S, R, 4);
  let iH = reviewIvl(sH, cfg, seed + 'h');
  let iG = reviewIvl(sG, cfg, seed + 'g');
  let iE = reviewIvl(sE, cfg, seed + 'e');
  iH = Math.min(iH, Math.max(1, (st.ivl || 1)) + Math.max(1, Math.round((st.ivl || 1) * 0.2)));
  iG = Math.max(iG, iH + 1);
  iE = Math.max(iE, iG + 1);
  const [S, ivl] = g === 2 ? [sH, iH] : g === 3 ? [sG, iG] : [sE, iE];
  return graduate(S, D, clamp(ivl, 1, cfg.maxIvl));
}

// Intervalle affiché sous chaque bouton.
export function formatDelay(next, now) {
  if (next.state !== 'review') {
    const min = Math.max(1, Math.round((next.dueAt - now) / MINUTE));
    return min < 60 ? (min <= 1 ? '<1 min' : min + ' min') : Math.round(min / 60) + ' h';
  }
  return formatDays(next.ivl);
}
export function formatDays(d) {
  if (d < 30) return d + ' j';
  if (d < 365) return (Math.round(d / 3.04) / 10).toString().replace('.', ',') + ' mois';
  return (Math.round(d / 36.5) / 10).toString().replace('.', ',') + ' an' + (d >= 730 ? 's' : '');
}

export function previewAll(st, now, settings, seedKey) {
  return [1, 2, 3, 4].map((g) => schedule(st, g, now, settings, seedKey));
}

// ---------- Paliers affichés (N, j1, j2, j4, j8, j16, j32+) ----------
export const BUCKETS = ['N', 'j1', 'j2', 'j4', 'j8', 'j16', 'j32+'];
export function bucketOf(st) {
  if (!st || !st.state || st.state === 'new') return 0;
  if (st.state !== 'review') return 1; // en apprentissage : revient dans la journée
  const i = st.ivl;
  return i <= 1 ? 1 : i <= 3 ? 2 : i <= 7 ? 3 : i <= 15 ? 4 : i <= 31 ? 5 : 6;
}

// Ancien format (boîtes de Leitner 1 à 5) vers le nouveau.
export function migrateCard(st) {
  if (!st || st.state) return st;
  if (!(st.box > 0)) return { state: 'new', last: st.last || 0 };
  const ivl = [1, 2, 4, 8, 16][st.box - 1];
  const due = st.due || today();
  return { state: 'review', S: ivl, D: 5, ivl, due, lastDay: addDays(due, -ivl), step: 0, n: st.n || 0, l: st.l || 0, last: st.last || 0 };
}
