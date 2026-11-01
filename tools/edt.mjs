// Récupère l'emploi du temps (et les devoirs) de Mon Bureau Numérique / Skolengo.
// Lancé par le workflow edt.yml du dépôt privé : node tools/edt.mjs <dossier du dépôt privé>
// Lit edt/auth.json (jeton obtenu avec scolengo-token, collé dans l'appli) et écrit edt/edt.json et edt/notes.json.
// Le jeton renouvelé est réenregistré dans edt/auth.json.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

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
// ---------- Colloscope (edt/colles.json) : vraies colles du groupe à la place des créneaux « COLLES TSI » ----------
const collesPath = path.join(dataDir, 'edt/colles.json');
const COLLE_NOM = { maths: 'maths', physique: 'physique', chimie: 'chimie', si: 'SI', anglais: 'anglais', francais: 'français' };
const colleTitle = (mat) => 'Colle ' + (/^[aeiouyé]/i.test(COLLE_NOM[mat] || mat) ? 'd\'' : 'de ') + (COLLE_NOM[mat] || mat);
// Heure de Paris (date « AAAA-MM-JJ », heure « HH:MM ») vers ISO UTC.
function parisToIso(date, hm) {
  for (const off of ['+01:00', '+02:00']) {
    const iso = new Date(date + 'T' + hm + ':00' + off).toISOString();
    const p = parisParts(iso);
    if (p.date === date && p.time === hm) return iso;
  }
  return new Date(date + 'T' + hm + ':00+01:00').toISOString();
}
function applyColles(lessons) {
  const c = readJson(collesPath);
  if (!c || !Array.isArray(c.colles)) return;
  const hide = plain(c.hideTitle || 'COLLES TSI');
  for (let i = lessons.length - 1; i >= 0; i--) if (plain(lessons[i].title) === hide) lessons.splice(i, 1);
  for (const k of c.colles) {
    lessons.push({ id: k.id, start: parisToIso(k.date, k.start), end: parisToIso(k.date, k.end), title: colleTitle(k.mat), mat: k.mat,
      colle: true, room: k.room || null, teachers: k.teacher ? [k.teacher] : [], canceled: false });
  }
}
function addCollesToAgenda() {
  const c = readJson(collesPath);
  if (!c || !Array.isArray(c.colles)) return;
  const agenda = readJson(agendaPath, { version: 1, items: [], deleted: [] });
  agenda.items = agenda.items || [];
  const gone = new Set(agenda.deleted || []);
  const have = new Set(agenda.items.map((it) => it.id));
  const today = parisParts(new Date().toISOString()).date;
  let added = 0;
  for (const k of c.colles) {
    if (have.has(k.id) || gone.has(k.id) || k.date < today) continue;
    const now = Date.now();
    agenda.items.push({
      id: k.id, title: [k.teacher, k.room].filter(Boolean).join(' · '), type: 'colle', mat: k.mat, chaps: [],
      date: k.date, time: k.start, prio: 0, flag: false, notes: 'De ' + k.start.replace(':', 'h') + ' à ' + k.end.replace(':', 'h') + (k.room ? ', salle ' + k.room : '') + '.',
      subs: [], done: false, created: now, t: now, doneAt: null, src: 'colloscope',
    });
    added++;
  }
  if (added) fs.writeFileSync(agendaPath, JSON.stringify(agenda));
  console.log('Colles ajoutées au calendrier :', added);
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

// ---------- Notes (module Évaluations de Skolengo) ----------
// Pour l'instant le serveur de Skolengo plante sur ce module pour ce lycée : on réessaie à chaque passage
// (deux fois par jour) et on garde les dernières notes connues tant que ça échoue.
const histPath = path.join(dataDir, 'edt/notes-history.json');
async function fetchNotes(user, student) {
  const prev = readJson(notesPath, {});
  const tries = [];
  const attempt = async (label, fn) => { try { return await fn(); } catch (e) { tries.push(label + ' : ' + [e && (e.status || (e.response && e.response.status)), e && e.code, e && e.title, (e && e.message) || e].filter(Boolean).join(' | ')); return null; } };
  let settings = await attempt('réglages', () => user.getEvaluationSettings(student));
  if (!settings) settings = await attempt('réglages (périodes)', () => user.getEvaluationSettings(student, 20, 0, {}, ['periods']));
  const s0 = settings && settings[0];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
  const periods = [];
  for (const per of (s0 && s0.periods) || []) {
    // L'appli officielle demande seulement certains champs (« fields ») : le serveur évite alors
    // de construire les fiches complètes des personnes, là où il plante.
    const FIELDS = { fields: {
      evaluationService: 'coefficient,average,studentAverage,scale,subject,evaluations,teachers',
      subject: 'label,color',
      evaluation: 'title,topic,dateTime,coefficient,average,min,max,scale,evaluationResult',
      evaluationResult: 'mark,nonEvaluationReason,comment',
      teacher: 'firstName,lastName,title',
    } };
    const BASE = ['subject', 'evaluations', 'evaluations.evaluationResult'];
    let ev = await attempt('notes ' + per.label + ' (champs choisis)', () => user.getEvaluation(student, per.id, 100, 0, FIELDS, [...BASE, 'teachers']));
    if (!ev) ev = await attempt('notes ' + per.label + ' (champs choisis, sans profs)', () => user.getEvaluation(student, per.id, 100, 0, FIELDS, BASE));
    if (!ev) ev = await attempt('notes ' + per.label + ' (sans profs)', () => user.getEvaluation(student, per.id, 100, 0, {}, BASE));
    if (!ev) ev = await attempt('notes ' + per.label + ' (sans inclusions)', () => user.getEvaluation(student, per.id, 100, 0, { fields: { evaluationService: 'coefficient,average,studentAverage,scale' } }, []));
    if (!ev) ev = await attempt('notes ' + per.label, () => user.getEvaluation(student, per.id, 100));
    if (!ev) continue;
    const subjects = ev.map((e) => ({
      label: (e.subject && e.subject.label) || '', mat: matiereOf(e.subject && e.subject.label),
      teacher: (e.teachers || []).map((t) => [t.title, t.lastName].filter(Boolean).join(' ')).filter(Boolean).join(', '),
      coef: e.coefficient ?? 1, average: e.studentAverage ?? null, classAverage: e.average ?? null, min: e.min ?? null, max: e.max ?? null,
      evaluations: (e.evaluations || []).slice().sort((a, b) => String(b.dateTime || '').localeCompare(String(a.dateTime || ''))).map((x) => {
        const r = x.evaluationResult || {};
        const mark = typeof r.mark === 'number' ? r.mark : null;
        return {
          id: x.id, mark, raw: mark === null ? (r.nonEvaluationReason || 'Non évalué') : String(mark), scale: x.scale ?? 20,
          title: x.title || null, topic: x.topic || null, date: x.dateTime || null, coef: x.coefficient ?? null,
          classAverage: x.average ?? null, min: x.min ?? null, max: x.max ?? null, comment: r.comment || null,
        };
      }),
    })).filter((x, i, all) => x.evaluations.length || all.findIndex((y) => y.label === x.label) === i); // matières en double (EPS)
    // Intitulés : absents de la liste, on les lit dans le détail de chaque évaluation (mêmes champs réduits).
    for (const sub of subjects) for (const x of sub.evaluations) {
      if (x.topic || !x.id) continue;
      const d = await attempt('détail ' + x.id, () => user.getEvaluationDetail(student, x.id, { fields: {
        evaluation: 'title,topic,dateTime,coefficient,min,max,average,scale,evaluationResult', evaluationResult: 'mark,nonEvaluationReason,comment',
      } }, ['evaluationResult']));
      if (!d) continue;
      x.title = d.title || x.title; x.topic = d.topic || null;
      if (x.classAverage === null) x.classAverage = d.average ?? null;
      if (x.min === null) x.min = d.min ?? null;
      if (x.max === null) x.max = d.max ?? null;
      if (x.coef === null) x.coef = d.coefficient ?? null;
      if (!x.comment && d.evaluationResult) x.comment = d.evaluationResult.comment || null;
    }
    // Une note ne compte pas dans la moyenne quand son coefficient est nul (grisée sur l'ENT).
    for (const sub of subjects) for (const x of sub.evaluations) x.counted = x.coef !== 0;
    // Moyenne générale : moyenne des matières pondérée par leurs coefficients.
    const avg = (k) => { const v = subjects.filter((x) => typeof x[k] === 'number'); const w = v.reduce((a, x) => a + (x.coef || 1), 0); return w ? Math.round(v.reduce((a, x) => a + x[k] * (x.coef || 1), 0) / w * 100) / 100 : null; };
    periods.push({ id: per.id, label: per.label, current: (per.startDate || '') <= today && today <= (per.endDate || '9999'), general: avg('average'), classGeneral: avg('classAverage'), subjects });
  }
  if (!periods.some((p) => p.subjects.length)) {
    write(notesPath, { ...prev, periods: prev.periods || [], source: 'api', error: 'L\'API de Skolengo ne donne pas encore les notes (panne de leur serveur). Nouvel essai automatique deux fois par jour.', errorAt: Date.now(), tries });
    console.log('Notes : échec |', tries.join(' / '));
    return;
  }
  write(notesPath, { source: 'api', updated: Date.now(), periods });
  const hist = readJson(histPath, { points: [] });
  periods.forEach((p) => {
    if (p.general === null) return;
    hist.points = hist.points.filter((x) => !(x.date === today && x.period === p.label));
    hist.points.push({ date: today, period: p.label, general: p.general, classGeneral: p.classGeneral });
  });
  write(histPath, hist);
  console.log('Notes :', periods.map((p) => p.label + ' ' + p.subjects.length + ' matières').join(', '));
}

// ---------- Pièces jointes des devoirs : enregistrées dans le dépôt privé ; PDF rangés au Classeur ----------
const blobSha = (buf) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + buf.length + '\0'), buf])).digest('hex');
const diag = [];
async function fetchAttachments(user, student, homework) {
  const indexPath = path.join(dataDir, 'classeur/index.json');
  const index = readJson(indexPath, { version: 1, docs: [] });
  index.docs = index.docs || [];
  let added = 0, indexChanged = false;
  const today = parisParts(new Date().toISOString()).date;
  for (const h of homework) {
    if (parisParts(h.due).date < today) continue;
    let full = null;
    try { full = await user.getHomeworkAssignment(student, h.id); } catch (e) {
      diag.push('devoir ' + h.id + ' : ' + e.message);
      try { full = await user.getHomeworkAssignment(student, h.id, undefined, ['attachments']); } catch (e2) { diag.push('devoir ' + h.id + ' (PJ seules) : ' + e2.message); }
    }
    if (full) diag.push('devoir ' + h.id + ' : ' + ((full.attachments || []).length) + ' PJ' + (full.pedagogicContent ? ', contenu pédagogique' : ''));
    const atts = (full && full.attachments) || [];
    h.attachments = [];
    for (const a of atts) {
      diag.push('PJ trouvée : ' + (a.name || a.id) + ' · ' + (a.mimeType || '?') + ' · ' + (a.url ? String(a.url).replace(/[?#].*$/, '').slice(0, 80) : 'sans adresse'));
      const safe = String(a.id).replace(/[^a-zA-Z0-9]/g, '-');
      const name = a.name || ('piece-jointe-' + safe);
      const isPdf = /pdf/i.test(a.mimeType || '') || /\.pdf$/i.test(name);
      const file = isPdf ? 'classeur/files/ent-' + safe + '.pdf' : 'edt/files/' + safe + '-' + name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const abs = path.join(dataDir, file);
      if (!fs.existsSync(abs)) {
        try {
          const stream = await user.downloadAttachment(a);
          const chunks = [];
          for await (const c of stream) chunks.push(Buffer.from(c));
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, Buffer.concat(chunks));
          added++;
        } catch (e) {
          // Fichier servi par le site de l'ENT (session du navigateur) : on garde le lien.
          diag.push('PJ ' + name + ' : lien seulement (' + ((e.response && e.response.status) || '') + ' ' + e.message + ')');
          h.attachments.push({ name, url: a.url, mime: a.mimeType || null });
          continue;
        }
      }
      const att = { name, file, mime: a.mimeType || null, size: fs.statSync(abs).size };
      if (isPdf) {
        const docId = 'ent-' + safe;
        if (!index.docs.some((d) => d.id === docId)) {
          index.docs.push({ id: docId, nom: name.replace(/\.pdf$/i, ''), type: 'td', chapId: '', matiere: matiereOf(h.subject), file, sha: blobSha(fs.readFileSync(abs)), size: att.size, added: Date.now(), src: 'ent' });
          indexChanged = true;
        }
        att.doc = docId;
      }
      h.attachments.push(att);
    }
  }
  if (indexChanged) fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
  // Les devoirs déjà dans le calendrier reçoivent la liste de leurs pièces jointes.
  const agenda = readJson(agendaPath, null);
  if (agenda && agenda.items) {
    let changed = false;
    homework.forEach((h) => {
      const it = agenda.items.find((x) => x.id === 'ent-' + String(h.id).replace(/[^a-zA-Z0-9]/g, '-'));
      if (it && (h.attachments || []).length && JSON.stringify(it.attachments || []) !== JSON.stringify(h.attachments)) { it.attachments = h.attachments; it.t = Date.now(); changed = true; }
    });
    if (changed) fs.writeFileSync(agendaPath, JSON.stringify(agenda));
  }
  console.log('Pièces jointes téléchargées :', added);
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
  applyColles(lessons);
  lessons.sort((x, y) => x.start.localeCompare(y.start));
  write(outPath, { updated: Date.now(), from: start, to: end, lessons, homework });
  console.log('Cours :', lessons.length, '| devoirs :', homework.length, '| du', start, 'au', end);
  addHomeworkToAgenda(homework);
  addCollesToAgenda();
  await fetchAttachments(user, student, homework);
  write(outPath, { updated: Date.now(), from: start, to: end, lessons, homework, diag });
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
