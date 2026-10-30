// Rappels envoyés par GitHub Actions (workflow du dépôt privé), environ une fois par heure.
// Usage : node tools/notify.mjs <dossier du dépôt privé> [--dry]
// Lit notifications/config.json (réglages et appareils abonnés, écrits par l'appli),
// notifications/vapid.json (clés), progress.json, et les cartes de ce dépôt.
// Écrit notifications/state.json (rappels déjà envoyés aujourd'hui).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sendPush } from './webpush.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.argv[2] || '.');
const dry = process.argv.includes('--dry');
const event = process.env.EVENT || 'schedule';
const SUBJECT = 'https://sneaqix.github.io/flashcards/';
const CATCH_UP_H = 3; // une exécution en retard rattrape le rappel jusqu'à 3 h après l'heure choisie

const readJson = (file, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
};

const cfg = readJson(path.join(dataDir, 'notifications/config.json'));
const vapid = readJson(path.join(dataDir, 'notifications/vapid.json'));
if (!cfg || !vapid) { console.log('Notifications non configurées.'); process.exit(0); }
if (cfg.tz) process.env.TZ = cfg.tz; // avant tout calcul de date

const S = await import('../js/store.js');
const statePath = path.join(dataDir, 'notifications/state.json');
const state = readJson(statePath, {});
state.sent = state.sent || {};
state.confirmed = state.confirmed || {};
state.gone = state.gone || {};
state.log = Array.isArray(state.log) ? state.log : [];
const before = JSON.stringify(state);

// ---------- Cartes du jour ----------
function loadChapters() {
  const index = readJson(path.join(appDir, 'decks/index.json'), { matieres: [] });
  return index.matieres.flatMap((m) => m.chapitres.map((file) => {
    const d = readJson(path.join(appDir, 'decks', file));
    return d && { id: d.id, nom: d.nom, cartes: d.cartes || [], matiere: m.id, matiereNom: m.nom };
  }).filter(Boolean));
}
const progress = S.normalize(readJson(path.join(dataDir, 'progress.json')));
const inactive = new Set(progress.settings.inactive || []);
const chapters = loadChapters().filter((c) => !inactive.has(c.id));
const matNames = new Map(chapters.map((c) => [c.matiere, c.matiereNom]));
const day = S.today();
// Comme dans l'appli : la Révision du jour inclut la préparation des DS et colles du calendrier.
const allChapters = loadChapters();
const byId = new Map(allChapters.map((c) => [c.id, c]));
const agendaData = readJson(path.join(dataDir, 'agenda.json'), { items: [] });
const exams = (agendaData.items || []).filter((it) => !it.done && (it.type === 'ds' || it.type === 'colle') && it.date);
const off = new Set(Array.isArray(progress.settings.dailyOff) ? progress.settings.dailyOff : ['francais']);
const q = S.dailyWithExams(progress, chapters.filter((c) => !off.has(c.matiere)), exams, byId);
// Compte par matière : la file du jour (préparation des DS comprise).
q.bySubject = {};
q.items.forEach((it) => {
  const m = it.chapter.matiere;
  q.bySubject[m] = q.bySubject[m] || { total: 0, fresh: 0 };
  q.bySubject[m].total++;
  if (it.kind === 'new') q.bySubject[m].fresh++;
});
const subjects = Object.entries(q.bySubject).filter(([, v]) => v.total > 0).sort((a, b) => b[1].total - a[1].total);
const total = subjects.reduce((s, [, v]) => s + v.total, 0);
const fresh = subjects.reduce((s, [, v]) => s + v.fresh, 0);
const reviewedToday = S.dayTotals(progress, day).r > 0;
function streak() {
  let i = reviewedToday ? 0 : 1, n = 0;
  while (S.dayTotals(progress, S.addDays(day, -i)).r > 0) { n++; i++; }
  return n;
}
const serie = streak();
const plural = (n, one, many) => n + ' ' + (n > 1 ? many : one);
const detail = subjects.map(([m, v]) => (matNames.get(m) || m) + ' ' + v.total).join(' · ');

// ---------- Envoi ----------
const settings = { revision: { on: true, hour: 18 }, serie: { on: true, hour: 21 }, ...(cfg.settings || {}) };
const devices = Object.entries(cfg.devices || {})
  .filter(([, d]) => d && d.on && d.sub && d.sub.endpoint && state.gone[d.sub.endpoint] == null);
const hourNow = new Date().getHours();
const epKey = (ep) => crypto.createHash('sha1').update(ep).digest('hex').slice(0, 12);

async function send(list, payload) {
  for (const [id, d] of list) {
    if (dry) { console.log('[essai]', id, JSON.stringify(payload)); continue; }
    try {
      const r = await sendPush(d.sub, payload, { jwk: vapid.jwk, subject: SUBJECT, topic: payload.tag });
      console.log(id, payload.tag, '→', r.status, r.text.slice(0, 200));
      state.log = [...state.log, { at: new Date().toISOString(), id, tag: payload.tag, status: r.status, text: r.text.slice(0, 300) }].slice(-20);
      if (r.status === 404 || r.status === 410) state.gone[d.sub.endpoint] = day;
    } catch (e) {
      console.log(id, payload.tag, '→ erreur', e.message);
      state.log = [...state.log, { at: new Date().toISOString(), id, tag: payload.tag, error: String(e.message).slice(0, 300) }].slice(-20);
    }
  }
}

function due(kind) {
  const s = settings[kind];
  return s && s.on && state.sent[kind] !== day && hourNow >= s.hour && hourNow < s.hour + CATCH_UP_H;
}
const h = (n) => n + ' h';

// Confirmation pour chaque nouvel abonnement.
const fresh_devices = devices.filter(([, d]) => !state.confirmed[epKey(d.sub.endpoint)]);
if (fresh_devices.length) {
  const parts = [];
  if (settings.revision.on) parts.push('cartes du jour à ' + h(settings.revision.hour));
  if (settings.serie.on) parts.push('série à ' + h(settings.serie.hour));
  await send(fresh_devices, {
    title: 'Notifications activées',
    body: parts.length ? 'Rappels : ' + parts.join(', ') + '.' : 'Aucun rappel choisi pour l\'instant.',
    tag: 'bienvenue', url: './#parametres',
  });
  fresh_devices.forEach(([, d]) => { state.confirmed[epKey(d.sub.endpoint)] = day; });
}

if (cfg.test && cfg.test !== state.test) {
  state.test = cfg.test;
  await send(devices, { title: 'Notification de test', body: 'Les rappels arrivent bien sur cet appareil.', tag: 'test', url: './#parametres' });
}

if (due('revision')) {
  state.sent.revision = day;
  if (total > 0) {
    await send(devices, {
      title: plural(total, 'carte à réviser', 'cartes à réviser') + (fresh ? ' (dont ' + plural(fresh, 'nouvelle', 'nouvelles') + ')' : ''),
      body: detail,
      tag: 'revision', url: './#reviser',
    });
  } else console.log('Rien à réviser aujourd\'hui.');
}

if (due('serie')) {
  state.sent.serie = day;
  if (!reviewedToday && (total > 0 || serie > 0)) {
    await send(devices, {
      title: serie > 0 ? 'Ta série de ' + plural(serie, 'jour', 'jours') + ' est en jeu' : 'Pas encore de révision aujourd\'hui',
      body: (serie > 0 ? 'Tu n\'as pas encore révisé aujourd\'hui. ' : '') + (total > 0 ? plural(total, 'carte t\'attend', 'cartes t\'attendent') + '.' : 'Quelques cartes suffisent.'),
      tag: 'serie', url: './#reviser',
    });
  } else console.log('Série : rien à rappeler.');
}

console.log(day, hourNow + ' h', '| à réviser', total, '| révisé aujourd\'hui', reviewedToday, '| série', serie, '| appareils', devices.length, '| évènement', event);
if (JSON.stringify(state) !== before) {
  state.updated = Date.now();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 1) + '\n');
}
