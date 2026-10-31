// Récupère l'emploi du temps (et les devoirs) de Mon Bureau Numérique / Skolengo.
// Lancé par le workflow edt.yml du dépôt privé : node tools/edt.mjs <dossier du dépôt privé>
// Lit edt/auth.json (jeton obtenu avec scolengo-token, collé dans l'appli) et écrit edt/edt.json.
// Le jeton renouvelé est réenregistré dans edt/auth.json.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const dataDir = path.resolve(process.argv[2] || '.');
const authPath = path.join(dataDir, 'edt/auth.json');
const outPath = path.join(dataDir, 'edt/edt.json');
const notesPath = path.join(dataDir, 'edt/notes.json');
const agendaPath = path.join(dataDir, 'agenda.json');
const appDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(path.join(process.env.SK_MODULES || process.cwd(), 'noop.js'));

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1) + '\n'); };
const iso = (d) => d.toISOString().slice(0, 10);

const auth = readJson(authPath);
const previous = readJson(outPath, { lessons: [], homework: [] });
if (!auth || !auth.tokenSet || !auth.school) { console.log('Pas de jeton : rien à faire.'); process.exit(0); }

function fail(msg) {
  console.log('Erreur :', msg);
  write(outPath, { ...previous, error: msg, errorAt: Date.now() });
  process.exit(0);
}

let Skolengo;
try { ({ Skolengo } = require('scolengo-api')); } catch (e) { fail('Module scolengo-api introuvable.'); }

const day = 86400000;
const now = new Date();
const monday = new Date(now.getTime() - ((now.getDay() + 6) % 7) * day);
const start = iso(new Date(monday.getTime() - 7 * day));  // semaine précédente
const end = iso(new Date(monday.getTime() + (8 * 7 - 1) * day)); // et huit semaines à venir

// ---------- Devoirs de l'ENT → éléments « Devoir » du Calendrier (agenda.json) ----------
const plain = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
const RULES = [[/SPORT|\bEPS\b/, null], [/MATH/, 'maths'], [/CHIM/, 'chimie'], [/PHYS/, 'physique'], [/INDUS|INGENIEUR|^S\.?I\.?$/, 'si'], [/ANGL/, 'anglais'], [/FRANC|PHILO/, 'francais']];
function matiereOf(label) {
  const index = readJson(path.join(appDir, 'decks/index.json'), { matieres: [] });
  const t = plain(label);
  const own = index.matieres.find((m) => plain(m.nom) === t || plain(m.id) === t);
  if (own) return own.id;
  const r = RULES.find(([re, id]) => re.test(t) && (id === null || index.matieres.some((m) => m.id === id)));
  return r ? r[1] : '';
}
function htmlToText(html) {
  return String(html || '')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (m, href, txt) => txt.replace(/<[^>]+>/g, '') + ' (' + href + ')')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function parisParts(isoStr) {
  const d = new Date(isoStr);
  const f = (loc, o) => new Intl.DateTimeFormat(loc, { timeZone: 'Europe/Paris', ...o }).format(d);
  return { date: f('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }), time: f('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) };
}
function addHomeworkToAgenda(homework) {
  const agenda = readJson(agendaPath, { version: 1, items: [], deleted: [] });
  agenda.items = agenda.items || [];
  agenda.deleted = agenda.deleted || [];
  const gone = new Set(agenda.deleted);
  const have = new Set(agenda.items.map((it) => it.id));
  const today = parisParts(new Date().toISOString()).date;
  let added = 0;
  for (const h of homework) {
    const id = 'ent-' + String(h.id).replace(/[^a-zA-Z0-9]/g, '-');
    if (have.has(id) || gone.has(id) || h.done) continue; // déjà là, supprimé ou fait : on ne touche à rien
    const { date, time } = parisParts(h.due);
    if (date < today) continue;
    const mat = matiereOf(h.subject);
    const now = Date.now();
    agenda.items.push({
      id, title: (mat ? '' : (h.subject ? h.subject + ' : ' : '')) + (h.title || 'Devoir'), type: 'devoir', mat, chaps: [],
      date, time: time && time !== '00:00' ? time : null, prio: 0, flag: false,
      notes: htmlToText(h.html), subs: [], done: false, created: now, t: now, doneAt: null, src: 'ent',
    });
    added++;
  }
  if (added) fs.writeFileSync(agendaPath, JSON.stringify(agenda));
  console.log('Devoirs ajoutés au calendrier :', added);
}

// ---------- Notes (module Évaluations de Skolengo, s'il est activé par le lycée) ----------
async function fetchNotes(user, student) {
  const out = { updated: Date.now(), periods: [] };
  try {
    const settings = await user.getEvaluationSettings(student);
    const s0 = settings && settings[0];
    if (!s0 || !(s0.periods || []).length) out.error = 'Aucune période de notes publiée sur l\'ENT.';
    for (const per of (s0 && s0.periods) || []) {
      const ev = await user.getEvaluation(student, per.id, 100);
      out.periods.push({
        id: per.id, label: per.label, start: per.startDate, end: per.endDate,
        subjects: ev.map((e) => ({
          label: (e.subject && e.subject.label) || '', mat: matiereOf(e.subject && e.subject.label),
          coef: e.coefficient, average: e.studentAverage, classAverage: e.average, scale: e.scale,
          evaluations: (e.evaluations || []).map((x) => ({
            title: x.title || x.topic || '', date: x.dateTime, coef: x.coefficient, scale: x.scale,
            mark: x.evaluationResult ? x.evaluationResult.mark : null,
            reason: x.evaluationResult ? x.evaluationResult.nonEvaluationReason : null,
            comment: x.evaluationResult ? x.evaluationResult.comment : null,
            classAverage: x.average, min: x.min, max: x.max,
          })),
        })),
      });
    }
  } catch (e) {
    const status = e && e.response && e.response.status;
    out.error = 'Notes indisponibles (' + (status ? 'HTTP ' + status : (e && e.message) || e) + ') : le module Évaluations n\'est peut-être pas activé par le lycée.';
  }
  write(notesPath, out);
  const n = out.periods.reduce((a, p) => a + p.subjects.reduce((b, sb) => b + sb.evaluations.length, 0), 0);
  console.log('Notes :', out.periods.length, 'périodes,', n, 'évaluations', out.error ? '| ' + out.error : '');
}

let refreshed = false;
try {
  const user = await Skolengo.fromConfigObject(auth, {
    onTokenRefresh: (tokenSet) => { auth.tokenSet = tokenSet; refreshed = true; },
  });
  // Renouvelle le jeton s'il expire bientôt (le jeton de renouvellement reste ainsi valide).
  const exp = auth.tokenSet.expires_at || 0;
  if (exp * 1000 < Date.now() + 10 * 60000) await user.refreshToken();
  const student = user.getTokenClaims().sub;
  const agendas = await user.getAgenda(student, start, end, 100);
  const name = (t) => [t.title, t.lastName].filter(Boolean).join(' ') || [t.firstName, t.lastName].filter(Boolean).join(' ');
  const lessons = [], homework = [];
  for (const a of agendas) {
    for (const l of a.lessons || []) {
      lessons.push({
        id: l.id, start: l.startDateTime, end: l.endDateTime,
        title: (l.subject && l.subject.label) || l.title || '',
        color: (l.subject && l.subject.color) || null,
        room: [l.location, l.locationComplement].filter(Boolean).join(' · ') || null,
        teachers: (l.teachers || []).map(name).filter(Boolean),
        canceled: !!l.canceled,
      });
    }
    for (const h of a.homeworkAssignments || []) {
      homework.push({
        id: h.id, title: h.title || '', due: h.dueDateTime || a.date,
        subject: (h.subject && h.subject.label) || '', done: !!h.done,
        html: h.html || '',
      });
    }
  }
  lessons.sort((x, y) => x.start.localeCompare(y.start));
  write(outPath, { updated: Date.now(), from: start, to: end, lessons, homework });
  console.log('Cours :', lessons.length, '| devoirs :', homework.length, '| du', start, 'au', end);
  addHomeworkToAgenda(homework);
  await fetchNotes(user, student);
} catch (e) {
  const status = e && e.response && e.response.status;
  const msg = /invalid_grant|refresh/i.test(String(e && e.message)) || status === 401
    ? 'Jeton expiré ou révoqué : recrée-le avec scolengo-token et colle-le dans les réglages.'
    : 'Échec de la récupération (' + (status ? 'HTTP ' + status : (e && e.message) || e) + ').';
  if (refreshed) write(authPath, auth);
  fail(msg);
}
if (refreshed) write(authPath, auth);
