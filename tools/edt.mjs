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
const end = iso(new Date(monday.getTime() + 27 * day));   // et trois semaines à venir

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
} catch (e) {
  const status = e && e.response && e.response.status;
  const msg = /invalid_grant|refresh/i.test(String(e && e.message)) || status === 401
    ? 'Jeton expiré ou révoqué : recrée-le avec scolengo-token et colle-le dans les réglages.'
    : 'Échec de la récupération (' + (status ? 'HTTP ' + status : (e && e.message) || e) + ').';
  if (refreshed) write(authPath, auth);
  fail(msg);
}
if (refreshed) write(authPath, auth);
