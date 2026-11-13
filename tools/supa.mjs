// Outils du dépôt privé pour les comptes Supabase (lancés par GitHub Actions).
//   node tools/supa.mjs migrate <dossier appli> <dossier données> <identifiant>
//       Copie cartes, progression, calendrier, carnets, classeur, emploi du temps et notes dans le compte.
//   node tools/supa.mjs pull <dossier appli> <dossier données> <identifiant>
//       Avant un robot : écrit les documents du compte en fichiers (cartes dans <appli>/decks).
//   node tools/supa.mjs push <dossier appli> <dossier données> <identifiant>
//       Après un robot : renvoie les fichiers modifiés (contrôle de version) et les nouveaux PDF.
// Variables : SUPABASE_SECRET_KEY (secret du dépôt, jamais écrit ailleurs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const URL_ = process.env.SUPABASE_URL || 'https://nqrnqpoklbcfncyxagcz.supabase.co';
const KEY = process.env.SUPABASE_SECRET_KEY;
const [cmd, appArg, dataArg, username] = process.argv.slice(2);
if (!KEY) { console.log('SUPABASE_SECRET_KEY absent : rien à faire.'); process.exit(cmd === 'migrate' ? 1 : 0); }
if (!['migrate', 'pull', 'push', 'inspect', 'reorganize', 'reorganize-apply', 'share', 'copy-decks', 'usage', 'copy-settings', 'modes', 'align', 'grep'].includes(cmd) || !username) { console.log('Usage : migrate|pull|push <appli> <données> <identifiant>'); process.exit(1); }
const appDir = path.resolve(appArg), dataDir = path.resolve(dataArg);
const manifestPath = path.join(dataDir, '.supa-pull.json');

const headers = (extra = {}) => ({ apikey: KEY, ...(KEY.startsWith('eyJ') ? { Authorization: 'Bearer ' + KEY } : {}), ...extra });
async function api(method, p, body, extra = {}) {
  const isBin = body instanceof Uint8Array || Buffer.isBuffer(body);
  const res = await fetch(URL_ + p, {
    method,
    headers: headers({ ...(body !== undefined && !isBin ? { 'Content-Type': 'application/json' } : {}), ...extra }),
    body: body === undefined ? undefined : isBin ? body : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(method + ' ' + p.split('?')[0] + ' : ' + res.status + ' ' + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const mime = (f) => (/\.pdf$/i.test(f) ? 'application/pdf' : /\.png$/i.test(f) ? 'image/png' : /\.jpe?g$/i.test(f) ? 'image/jpeg' : 'application/octet-stream');

// Fichiers JSON suivis dans le dépôt privé (les cartes viennent du dossier de l'appli).
// edt/share.json et edt/colloscope-groupes.json restent dans le dépôt privé (réglage des robots), jamais dans le compte.
const REPO_ONLY = ['edt/share.json', 'edt/colloscope-groupes.json'];
const DATA_DOCS = (f) => !REPO_ONLY.includes(f) && (/^(progress|agenda)\.json$/.test(f) || /^(carnets|classeur|edt|notifications)\/.+\.json$/.test(f));
function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.name.startsWith('.')) return [];
    return e.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}
const fileOf = (p) => (p.startsWith('decks/') ? path.join(appDir, p) : path.join(dataDir, p));

async function userId() {
  const rows = await api('GET', '/rest/v1/profiles?select=id,features&username=eq.' + encodeURIComponent(username.toLowerCase()));
  if (!rows.length) throw new Error('Compte « ' + username + ' » introuvable : crée-le d\'abord dans l\'appli.');
  return rows[0];
}
async function storedFiles(uid, prefix) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const rows = await api('POST', '/storage/v1/object/list/files', { prefix: uid + '/' + prefix, limit: 1000, offset });
    rows.forEach((r) => out.push(prefix + r.name));
    if (rows.length < 1000) return new Set(out);
  }
}
async function uploadFile(uid, rel, full) {
  await api('POST', '/storage/v1/object/files/' + uid + '/' + enc(rel), fs.readFileSync(full), { 'x-upsert': 'true', 'Content-Type': mime(rel) });
}

async function migrate() {
  const prof = await userId();
  const uid = prof.id;
  const docs = [
    ...walk(path.join(appDir, 'decks')).filter((f) => f.endsWith('.json')).map((f) => 'decks/' + f),
    ...walk(dataDir).filter(DATA_DOCS),
  ];
  for (let i = 0; i < docs.length; i += 50) {
    const rows = docs.slice(i, i + 50).map((p) => ({ user_id: uid, path: p, content: fs.readFileSync(fileOf(p), 'utf8'), version: 1, updated_at: new Date().toISOString() }));
    await api('POST', '/rest/v1/docs?on_conflict=user_id,path', rows, { Prefer: 'resolution=merge-duplicates,return=minimal' });
  }
  console.log('Documents copiés :', docs.length);
  const pdfs = walk(path.join(dataDir, 'classeur')).filter((f) => !f.endsWith('.json')).map((f) => 'classeur/' + f);
  for (const f of pdfs) await uploadFile(uid, f, path.join(dataDir, f));
  console.log('Fichiers du classeur copiés :', pdfs.length);
  const features = { ...(prof.features || {}), notes: true, edt: true, edtSync: true, notifs: true };
  await api('PATCH', '/rest/v1/profiles?id=eq.' + uid, { features }, { Prefer: 'return=minimal' });
  console.log('Pages réservées activées pour', username, ':', Object.keys(features).join(', '));
}

async function pull() {
  const { id: uid } = await userId();
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await api('GET', '/rest/v1/docs?select=path,content,version&user_id=eq.' + uid + '&order=path&limit=1000&offset=' + offset);
    rows.push(...page);
    if (page.length < 1000) break;
  }
  const manifest = { uid, docs: {} };
  for (const r of rows) {
    if (REPO_ONLY.includes(r.path)) continue;
    const f = fileOf(r.path);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, r.content);
    manifest.docs[r.path] = { version: r.version, sha: sha(r.content) };
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  console.log('Documents lus depuis le compte :', rows.length);
}

async function push() {
  if (!fs.existsSync(manifestPath)) { console.log('Pas de lecture préalable : rien à envoyer.'); return; }
  const { uid, docs } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let sent = 0, conflicts = 0;
  const candidates = [...new Set([...Object.keys(docs), ...walk(dataDir).filter(DATA_DOCS)])];
  for (const p of candidates) {
    const f = fileOf(p);
    if (!fs.existsSync(f)) continue;
    const content = fs.readFileSync(f, 'utf8');
    const known = docs[p];
    if (known && known.sha === sha(content)) continue;
    if (known) {
      const r = await api('PATCH', '/rest/v1/docs?user_id=eq.' + uid + '&path=eq.' + encodeURIComponent(p) + '&version=eq.' + known.version,
        { content, version: known.version + 1, updated_at: new Date().toISOString() }, { Prefer: 'return=representation' });
      if (!r.length) { conflicts++; console.log('Modifié entre-temps dans l\'appli, non écrasé :', p); continue; }
    } else {
      await api('POST', '/rest/v1/docs?on_conflict=user_id,path', { user_id: uid, path: p, content }, { Prefer: 'resolution=ignore-duplicates,return=minimal' });
    }
    sent++;
  }
  // Nouveaux PDF ajoutés par le robot (pièces jointes des devoirs).
  const have = await storedFiles(uid, 'classeur/files/');
  const local = walk(path.join(dataDir, 'classeur/files')).map((f) => 'classeur/files/' + f).filter((f) => !have.has(f));
  for (const f of local) await uploadFile(uid, f, path.join(dataDir, f));
  fs.rmSync(manifestPath, { force: true });
  console.log('Documents envoyés :', sent, '· conflits :', conflicts, '· nouveaux fichiers :', local.length);
}

// Structure des cartes d'un compte (matières, chapitres, nombre de cartes et premières questions).
async function inspect() {
  const { id: uid } = await userId();
  const rows = await api('GET', '/rest/v1/docs?select=path,content&user_id=eq.' + uid + '&path=like.decks/*&order=path');
  const byPath = new Map(rows.map((r) => [r.path, JSON.parse(r.content)]));
  const index = byPath.get('decks/index.json') || { matieres: [] };
  console.log('== Index');
  index.matieres.forEach((m) => {
    console.log('MATIERE', m.id, '|', m.nom);
    m.chapitres.forEach((f) => {
      const d = byPath.get('decks/' + f);
      console.log('  CHAP', f, '|', d ? d.id + ' | ' + d.nom + ' | ' + (d.cartes || []).length + ' cartes' : 'ABSENT');
      (d && d.cartes || []).forEach((c) => console.log('    Q', c.id, '|', String(c.q).replace(/\s+/g, ' ').slice(0, 90)));
    });
  });
  const orphan = [...byPath.keys()].filter((p) => p !== 'decks/index.json' && !index.matieres.some((m) => m.chapitres.includes(p.slice(6))));
  if (orphan.length) console.log('Hors index :', orphan.join(', '));
}

// Range les chapitres importés « Matière – Chapitre » d'un compte comme ceux du compte de référence
// (mêmes matières, noms, identifiants et ordre). Progression, chapitres désactivés et calendrier suivent.
// « reorganize » affiche le plan sans rien changer ; « reorganize-apply » l'applique.
const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
async function docsOf(uid, filter) {
  return api('GET', '/rest/v1/docs?select=path,content,version&user_id=eq.' + uid + (filter || '') + '&order=path&limit=1000');
}
async function reorganize(apply) {
  const ref = process.env.REF_USERNAME || 'Louison-BLEGER';
  const target = await userId();
  const refRows = await api('GET', '/rest/v1/profiles?select=id&username=eq.' + encodeURIComponent(ref.toLowerCase()));
  if (!refRows.length) throw new Error('Compte de référence introuvable : ' + ref);
  const refDocs = new Map((await docsOf(refRows[0].id, '&path=like.decks/*')).map((r) => [r.path, JSON.parse(r.content)]));
  const refIndex = refDocs.get('decks/index.json');
  const rows = await docsOf(target.id);
  const docs = new Map(rows.map((r) => [r.path, r]));
  const index = JSON.parse(docs.get('decks/index.json').content);
  // Chapitres de référence : « matière – chapitre » normalisé → { matière, fichier, id, nom }.
  const refChap = new Map();
  refIndex.matieres.forEach((m) => m.chapitres.forEach((f) => {
    const d = refDocs.get('decks/' + f);
    if (d) refChap.set(norm(m.nom) + '|' + norm(d.nom), { mat: m, file: f, id: d.id, nom: d.nom });
  }));
  const plan = [];          // { from: {file, id}, to: refChap, cards }
  const keep = [];          // chapitres non importés et non vides : { mat, file }
  const drop = [];          // chapitres vides supprimés
  const ownMats = new Map();
  index.matieres.forEach((m) => m.chapitres.forEach((f) => {
    const r = docs.get('decks/' + f);
    const d = r ? JSON.parse(r.content) : null;
    const cards = (d && d.cartes) || [];
    const parts = d ? String(d.nom).split(/\s+[–-]\s+/) : [];
    const hit = parts.length === 2 ? refChap.get(norm(parts[0]) + '|' + norm(parts[1])) : null;
    if (hit && cards.length) plan.push({ from: { file: f, id: d.id }, to: hit, cards });
    else if (!cards.length) drop.push(f);
    else { keep.push({ mat: m, file: f }); ownMats.set(m.id, m); }
  }));
  // Nouvel index : matières de référence (dans leur ordre) qui reçoivent des cartes, puis les autres chapitres gardés.
  const out = { matieres: [] };
  refIndex.matieres.forEach((m) => {
    const chs = m.chapitres.filter((f) => plan.some((p) => p.to.file === f));
    const kept = keep.filter((k) => k.mat.id === m.id).map((k) => k.file);
    if (chs.length || kept.length) out.matieres.push({ id: m.id, nom: m.nom, chapitres: [...chs, ...kept] });
  });
  ownMats.forEach((m) => {
    if (out.matieres.some((x) => x.id === m.id)) return;
    out.matieres.push({ ...m, chapitres: keep.filter((k) => k.mat.id === m.id).map((k) => k.file) });
  });
  console.log('== Plan');
  plan.forEach((p) => console.log('  ' + p.from.file + ' → ' + p.to.mat.nom + ' / ' + p.to.nom + ' (' + p.to.file + ', ' + p.cards.length + ' cartes)'));
  keep.forEach((k) => console.log('  gardé : ' + k.mat.nom + ' / ' + k.file));
  drop.forEach((f) => console.log('  supprimé (vide) : ' + f));
  console.log('== Nouvel index');
  out.matieres.forEach((m) => console.log('  ' + m.nom + ' : ' + m.chapitres.join(', ')));
  // Correspondance des identifiants de chapitre.
  const idMap = new Map(plan.map((p) => [p.from.id, p.to.id]));
  const prog = docs.get('progress.json');
  let moved = 0;
  let progOut = null;
  if (prog) {
    const pj = JSON.parse(prog.content);
    const cards = pj.cards || {};
    Object.keys(cards).forEach((k) => {
      const [ch, rest] = [k.slice(0, k.indexOf('/')), k.slice(k.indexOf('/') + 1)];
      if (!idMap.has(ch)) return;
      const nk = idMap.get(ch) + '/' + rest;
      if (!cards[nk] || (cards[nk].last || 0) < (cards[k].last || 0)) cards[nk] = cards[k];
      delete cards[k];
      moved++;
    });
    if (pj.settings && Array.isArray(pj.settings.inactive)) pj.settings.inactive = [...new Set(pj.settings.inactive.map((x) => idMap.get(x) || x))];
    progOut = JSON.stringify(pj);
  }
  const ag = docs.get('agenda.json');
  let agOut = null;
  if (ag) {
    const aj = JSON.parse(ag.content);
    (aj.items || []).forEach((it) => { if (Array.isArray(it.chaps)) it.chaps = it.chaps.map((x) => idMap.get(x) || x); });
    agOut = JSON.stringify(aj);
  }
  console.log('Progression déplacée :', moved, 'faces');
  if (!apply) { console.log('(aperçu : rien n\'a été modifié)'); return; }
  const now = new Date().toISOString();
  const upsert = (p, content) => api('POST', '/rest/v1/docs?on_conflict=user_id,path', { user_id: target.id, path: p, content, version: ((docs.get(p) || {}).version || 0) + 1, updated_at: now }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
  for (const p of plan) await upsert('decks/' + p.to.file, JSON.stringify({ id: p.to.id, nom: p.to.nom, cartes: p.cards }, null, 2) + '\n');
  await upsert('decks/index.json', JSON.stringify(out, null, 2) + '\n');
  const newFiles = new Set(plan.map((p) => 'decks/' + p.to.file));
  for (const f of [...plan.map((p) => 'decks/' + p.from.file), ...drop.map((f) => 'decks/' + f)]) {
    if (newFiles.has(f)) continue;
    await api('DELETE', '/rest/v1/docs?user_id=eq.' + target.id + '&path=eq.' + encodeURIComponent(f), undefined, { Prefer: 'return=minimal' });
  }
  if (progOut) await upsert('progress.json', progOut);
  if (agOut) await upsert('agenda.json', agOut);
  console.log('Réorganisation appliquée.');
}

// Partage de l'emploi du temps : après le robot, copie edt/edt.json et ajoute les colles et devoirs de l'ENT
// dans le calendrier de chaque compte listé dans edt/share.json ({ "recipients": ["identifiant"] }).
// Colles d'un groupe (edt/colloscope-groupes.json : { "3": [{ id, date, start, end, mat, teacher, room }] }).
const COLLE_NOM = { maths: 'maths', physique: 'physique', chimie: 'chimie', si: 'SI', anglais: 'anglais', francais: 'français' };
const colleTitle = (mat) => 'Colle ' + (/^[aeiouyé]/i.test(COLLE_NOM[mat] || mat) ? 'd\'' : 'de ') + (COLLE_NOM[mat] || mat);
function parisToIso(date, hm) {
  for (const off of ['+01:00', '+02:00']) {
    const d = new Date(date + 'T' + hm + ':00' + off);
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
    const g = (t) => f.find((x) => x.type === t).value;
    if (g('year') + '-' + g('month') + '-' + g('day') === date && g('hour') + ':' + g('minute') === hm) return d.toISOString();
  }
  return new Date(date + 'T' + hm + ':00+01:00').toISOString();
}
const colleLesson = (k) => ({ id: k.id, start: parisToIso(k.date, k.start), end: parisToIso(k.date, k.end), title: colleTitle(k.mat), mat: k.mat, colle: true, room: k.room || null, teachers: k.teacher ? [k.teacher] : [], canceled: false });
const colleItem = (k) => ({
  id: k.id, title: [k.teacher, k.room].filter(Boolean).join(' · '), type: 'colle', mat: k.mat, chaps: [], date: k.date, time: k.start, prio: 0, flag: false,
  notes: 'De ' + k.start.replace(':', 'h') + ' à ' + k.end.replace(':', 'h') + (k.room ? ', salle ' + k.room : '') + '.',
  subs: [], done: false, created: Date.now(), t: Date.now(), doneAt: null, src: 'colloscope',
});

async function share() {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')); } catch (e) { return null; } };
  const cfg = read('edt/share.json');
  const list = ((cfg && cfg.recipients) || []).map((r) => (typeof r === 'string' ? { user: r, group: null } : r));
  if (!list.length) { console.log('Aucun compte avec qui partager.'); return; }
  const groups = read('edt/colloscope-groupes.json') || {};
  const own = read('edt/colles.json');
  const ownGroup = own && own.group != null ? String(own.group) : null;
  const edtText = fs.readFileSync(path.join(dataDir, 'edt/edt.json'), 'utf8');
  const mine = JSON.parse(fs.readFileSync(path.join(dataDir, 'agenda.json'), 'utf8'));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
  const ent = (mine.items || []).filter((it) => it.src === 'ent' && !it.done && (it.date || '') >= today);
  const ownColles = (mine.items || []).filter((it) => it.src === 'colloscope' && !it.done && (it.date || '') >= today);
  for (const r of list) {
    const name = r.user;
    const group = r.group != null ? String(r.group) : ownGroup;
    // Même groupe que moi : mon emploi du temps tel quel ; autre groupe : ses propres colles à la place des miennes.
    let edt = edtText, shared = [...ownColles, ...ent];
    if (group !== ownGroup) {
      const gc = groups[group] || [];
      if (!gc.length) console.log(name + ' : aucune colle connue pour le groupe ' + group);
      const e = JSON.parse(edtText);
      e.lessons = [...(e.lessons || []).filter((l) => !l.colle), ...gc.map(colleLesson)].sort((a, b) => a.start.localeCompare(b.start));
      edt = JSON.stringify(e);
      shared = [...gc.filter((k) => k.date >= today).map(colleItem), ...ent];
    }
    const rows = await api('GET', '/rest/v1/profiles?select=id,features&username=eq.' + encodeURIComponent(name.toLowerCase()));
    if (!rows.length) { console.log('Compte introuvable :', name); continue; }
    const { id: uid, features } = rows[0];
    const now = new Date().toISOString();
    await api('POST', '/rest/v1/docs?on_conflict=user_id,path', { user_id: uid, path: 'edt/edt.json', content: edt, updated_at: now }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
    if (!(features && features.edt)) await api('PATCH', '/rest/v1/profiles?id=eq.' + uid, { features: { ...(features || {}), edt: true } }, { Prefer: 'return=minimal' });
    // Calendrier : on ajoute seulement ce qui manque (un élément supprimé par le compte ne revient pas).
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await api('GET', '/rest/v1/docs?select=content,version&user_id=eq.' + uid + '&path=eq.agenda.json');
      const ag = cur.length ? JSON.parse(cur[0].content) : { version: 1, items: [], deleted: [] };
      ag.items = ag.items || []; ag.deleted = ag.deleted || [];
      const have = new Set([...ag.items.map((x) => x.id), ...ag.deleted]);
      const add = shared.filter((it) => !have.has(it.id)).map((it) => ({ ...it, t: Date.now() }));
      if (!add.length) { console.log(name + ' : emploi du temps copié, calendrier déjà à jour (' + shared.length + ' à partager, ' + ag.items.length + ' éléments chez lui, dont ' + ag.items.filter((x) => x.src).length + ' partagés ; ' + ag.deleted.length + ' supprimés).'); break; }
      ag.items.push(...add);
      const content = JSON.stringify(ag);
      if (cur.length) {
        const r = await api('PATCH', '/rest/v1/docs?user_id=eq.' + uid + '&path=eq.agenda.json&version=eq.' + cur[0].version,
          { content, version: cur[0].version + 1, updated_at: now }, { Prefer: 'return=representation' });
        if (!r.length) continue; // modifié dans l'appli entre-temps : on relit
      } else {
        await api('POST', '/rest/v1/docs', { user_id: uid, path: 'agenda.json', content }, { Prefer: 'return=minimal' });
      }
      console.log(name + ' : emploi du temps copié, ' + add.length + ' élément(s) ajouté(s) au calendrier.');
      break;
    }
  }
}

// Copie de chapitres d'un compte vers un autre (copie unique, sans la progression).
// EXTRA = matières à copier, séparées par des virgules (ex. « maths,physique,chimie,si »).
async function copyDecks() {
  const src = process.env.REF_USERNAME || 'Louison-BLEGER';
  const mats = String(process.env.EXTRA || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!mats.length) throw new Error('Indique les matières à copier (EXTRA).');
  const target = await userId();
  const srcRows = await api('GET', '/rest/v1/profiles?select=id&username=eq.' + encodeURIComponent(src.toLowerCase()));
  if (!srcRows.length) throw new Error('Compte source introuvable : ' + src);
  const from = new Map((await docsOf(srcRows[0].id, '&path=like.decks/*')).map((r) => [r.path, r.content]));
  const mine = new Map((await docsOf(target.id, '&path=like.decks/*')).map((r) => [r.path, r]));
  const srcIndex = JSON.parse(from.get('decks/index.json'));
  const idx = mine.has('decks/index.json') ? JSON.parse(mine.get('decks/index.json').content) : { matieres: [] };
  const now = new Date().toISOString();
  let chapters = 0, cards = 0;
  for (const m of srcIndex.matieres.filter((x) => mats.includes(x.id))) {
    let tm = idx.matieres.find((x) => x.id === m.id);
    if (!tm) { tm = { ...m, chapitres: [] }; idx.matieres.push(tm); }
    for (const f of m.chapitres) {
      const content = from.get('decks/' + f);
      if (!content) continue;
      const n = (JSON.parse(content).cartes || []).length;
      if (!n) continue;
      if (mine.has('decks/' + f)) { console.log('  déjà présent, non écrasé :', f); continue; }
      await api('POST', '/rest/v1/docs', { user_id: target.id, path: 'decks/' + f, content, updated_at: now }, { Prefer: 'return=minimal' });
      if (!tm.chapitres.includes(f)) tm.chapitres.push(f);
      chapters++; cards += n;
      console.log('  ' + m.nom + ' / ' + f + ' (' + n + ' cartes)');
    }
  }
  const body = { user_id: target.id, path: 'decks/index.json', content: JSON.stringify(idx, null, 2) + '\n', version: ((mine.get('decks/index.json') || {}).version || 0) + 1, updated_at: now };
  await api('POST', '/rest/v1/docs?on_conflict=user_id,path', body, { Prefer: 'resolution=merge-duplicates,return=minimal' });
  console.log('Copié :', chapters, 'chapitres,', cards, 'cartes.');
}

// Place utilisée : taille des documents (par compte) et des fichiers stockés.
async function usage() {
  const profs = await api('GET', '/rest/v1/profiles?select=id,username&order=username');
  let docTotal = 0, fileTotal = 0, fileCount = 0;
  for (const p of profs) {
    let size = 0, n = 0;
    for (let offset = 0; ; offset += 500) {
      const rows = await api('GET', '/rest/v1/docs?select=content&user_id=eq.' + p.id + '&limit=500&offset=' + offset);
      rows.forEach((r) => { size += Buffer.byteLength(r.content); n++; });
      if (rows.length < 500) break;
    }
    docTotal += size;
    console.log('  ' + p.username + ' : ' + n + ' documents, ' + (size / 1024).toFixed(0) + ' Ko');
  }
  async function walkStore(bucket, prefix) {
    const rows = await api('POST', '/storage/v1/object/list/' + bucket, { prefix, limit: 1000, offset: 0 });
    for (const r of rows) {
      if (r.id === null) await walkStore(bucket, prefix + r.name + '/');
      else { fileTotal += (r.metadata && r.metadata.size) || 0; fileCount++; }
    }
  }
  for (const b of ['files', 'images']) await walkStore(b, '');
  console.log('Comptes :', profs.length);
  console.log('Documents (base de données) : ' + (docTotal / 1048576).toFixed(2) + ' Mo');
  console.log('Fichiers (stockage) : ' + fileCount + ' fichiers, ' + (fileTotal / 1048576).toFixed(2) + ' Mo');
}

// Copie des réglages de rythme (nouvelles cartes, révisions, planification) d'un compte vers un autre.
async function copySettings() {
  const src = process.env.REF_USERNAME || 'Louison-BLEGER';
  const target = await userId();
  const srcRows = await api('GET', '/rest/v1/profiles?select=id&username=eq.' + encodeURIComponent(src.toLowerCase()));
  const sp = await api('GET', '/rest/v1/docs?select=content&user_id=eq.' + srcRows[0].id + '&path=eq.progress.json');
  const from = JSON.parse(sp[0].content).settings || {};
  const KEYS = ['newPerDay', 'maxReviews', 'subjects', 'retention', 'maxIvl', 'learnSteps', 'relearnSteps'];
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await api('GET', '/rest/v1/docs?select=content,version&user_id=eq.' + target.id + '&path=eq.progress.json');
    const p = cur.length ? JSON.parse(cur[0].content) : { version: 3, cards: {}, logs: {}, settings: {} };
    p.settings = p.settings || {};
    KEYS.forEach((k) => { if (from[k] !== undefined) p.settings[k] = from[k]; });
    p.settings.updated = Date.now();
    const content = JSON.stringify(p);
    if (cur.length) {
      const r = await api('PATCH', '/rest/v1/docs?user_id=eq.' + target.id + '&path=eq.progress.json&version=eq.' + cur[0].version,
        { content, version: cur[0].version + 1, updated_at: new Date().toISOString() }, { Prefer: 'return=representation' });
      if (!r.length) continue;
    } else {
      await api('POST', '/rest/v1/docs', { user_id: target.id, path: 'progress.json', content }, { Prefer: 'return=minimal' });
    }
    console.log('Réglages copiés :', KEYS.filter((k) => from[k] !== undefined).map((k) => k + '=' + JSON.stringify(from[k])).join(', '));
    return;
  }
  throw new Error('progression modifiée pendant la copie, réessaie');
}

// Types de cartes d'un compte comparés au compte de référence (même chapitre, même identifiant de carte).
async function modes() {
  const ref = process.env.REF_USERNAME || 'Louison-BLEGER';
  const t = await userId();
  const r = await api('GET', '/rest/v1/profiles?select=id&username=eq.' + encodeURIComponent(ref.toLowerCase()));
  const load = async (uid) => new Map((await docsOf(uid, '&path=like.decks/*')).filter((x) => x.path !== 'decks/index.json').map((x) => [x.path, JSON.parse(x.content)]));
  const mine = await load(t.id), theirs = await load(r[0].id);
  const count = (m) => { const c = {}; m.forEach((d) => (d.cartes || []).forEach((k) => { const key = k.mode || 'classique'; c[key] = (c[key] || 0) + 1; })); return c; };
  console.log('Types chez ' + username + ' :', JSON.stringify(count(mine)));
  console.log('Types chez ' + ref + ' :', JSON.stringify(count(theirs)));
  let same = 0, diff = 0, missing = 0;
  const sample = [];
  mine.forEach((d, p) => {
    const ref = theirs.get(p);
    (d.cartes || []).forEach((k) => {
      const o = ref && (ref.cartes || []).find((x) => x.id === k.id);
      if (!o) { missing++; return; }
      if (JSON.stringify(o) === JSON.stringify(k)) same++;
      else { diff++; if (sample.length < 3) sample.push({ ref: Object.keys(o), lui: Object.keys(k), mode: [o.mode, k.mode] }); }
    });
  });
  console.log('Cartes identiques :', same, '· différentes :', diff, '· absentes chez ' + ref + ' :', missing);
  sample.forEach((x) => console.log('  ex.', JSON.stringify(x)));
}

// Remplace les cartes d'un compte par celles du compte de référence (mêmes chapitres), en gardant
// la progression : chaque carte est retrouvée par sa question, sa progression suit son nouvel identifiant.
// EXTRA=apply pour appliquer (sinon aperçu). Les cartes sans équivalent sont gardées en fin de chapitre.
const qnorm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/<[^>]+>/g, ' ').replace(/\{\{([^:}]*)::[^}]*\}\}/g, '$1').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
async function align() {
  const apply = process.env.EXTRA === 'apply';
  const ref = process.env.REF_USERNAME || 'Louison-BLEGER';
  const t = await userId();
  const r = await api('GET', '/rest/v1/profiles?select=id&username=eq.' + encodeURIComponent(ref.toLowerCase()));
  const refDocs = new Map((await docsOf(r[0].id, '&path=like.decks/*')).map((x) => [x.path, JSON.parse(x.content)]));
  const rows = await docsOf(t.id);
  const docs = new Map(rows.map((x) => [x.path, x]));
  const index = JSON.parse(docs.get('decks/index.json').content);
  const keyMap = new Map(); // ancienne clé de carte -> nouvelle
  const writes = [];
  let matched = 0, added = 0, kept = 0;
  for (const m of index.matieres) for (const f of m.chapitres) {
    const p = 'decks/' + f;
    const refD = refDocs.get(p), row = docs.get(p);
    if (!refD || !row) continue;
    const d = JSON.parse(row.content);
    const byQ = new Map();
    (d.cartes || []).forEach((c) => { const k = qnorm(c.q); if (!byQ.has(k)) byQ.set(k, c); });
    const used = new Set();
    const fresh = [];
    const out = refD.cartes.map((c) => {
      const old = byQ.get(qnorm(c.q));
      if (old && !used.has(old)) { used.add(old); matched++; if (old.id !== c.id) keyMap.set(d.id + '/' + old.id, refD.id + '/' + c.id); }
      else fresh.push(c);
      return c;
    });
    // Une seule carte sans équivalent de chaque côté : c'est la même, modifiée depuis.
    const left = (d.cartes || []).filter((c) => !used.has(c));
    if (fresh.length === 1 && left.length === 1) {
      used.add(left[0]); matched++;
      keyMap.set(d.id + '/' + left[0].id, refD.id + '/' + fresh[0].id);
      console.log('    appariée malgré une question modifiée : « ' + String(left[0].q).slice(0, 60) + ' »');
      fresh.length = 0;
    }
    added += fresh.length;
    const rest = (d.cartes || []).filter((c) => !used.has(c)).map((c) => (out.some((x) => x.id === c.id) ? { ...c, id: c.id + '-g' } : c));
    rest.forEach((c, i) => { kept++; const o = d.cartes.filter((x) => !used.has(x))[i]; if (o.id !== c.id) keyMap.set(d.id + '/' + o.id, d.id + '/' + c.id); });
    if (d.id !== refD.id) console.log('  attention : identifiant de chapitre différent', d.id, refD.id);
    console.log('  ' + f + ' : ' + (refD.cartes.length) + ' cartes de référence, ' + rest.length + ' gardées en plus');
    writes.push({ path: p, row, content: JSON.stringify({ ...d, id: refD.id, nom: refD.nom, cartes: [...out, ...rest] }, null, 2) + '\n' });
  }
  console.log('Retrouvées par la question :', matched, '· nouvelles :', added, '· sans équivalent (gardées) :', kept);
  // Progression : les deux faces (« » et « ~r ») suivent la carte.
  const prow = docs.get('progress.json');
  const prog = prow ? JSON.parse(prow.content) : null;
  let moved = 0;
  if (prog) {
    const cards = prog.cards || {};
    const next = {};
    Object.entries(cards).forEach(([k, v]) => {
      const rev = k.endsWith('~r');
      const base = rev ? k.slice(0, -2) : k;
      const nk = keyMap.has(base) ? keyMap.get(base) + (rev ? '~r' : '') : k;
      if (nk !== k) moved++;
      if (!next[nk] || (next[nk].last || 0) < (v.last || 0)) next[nk] = v;
    });
    prog.cards = next;
    console.log('Progression : ' + Object.keys(cards).length + ' faces, dont ' + moved + ' changent de clé.');
  }
  if (!apply) { console.log('(aperçu : rien n\'a été modifié)'); return; }
  for (const w of writes) {
    const res = await api('PATCH', '/rest/v1/docs?user_id=eq.' + t.id + '&path=eq.' + encodeURIComponent(w.path) + '&version=eq.' + w.row.version,
      { content: w.content, version: w.row.version + 1, updated_at: new Date().toISOString() }, { Prefer: 'return=representation' });
    if (!res.length) throw new Error('chapitre modifié entre-temps : ' + w.path + ' (relance)');
  }
  if (prog) {
    const res = await api('PATCH', '/rest/v1/docs?user_id=eq.' + t.id + '&path=eq.progress.json&version=eq.' + prow.version,
      { content: JSON.stringify(prog), version: prow.version + 1, updated_at: new Date().toISOString() }, { Prefer: 'return=representation' });
    if (!res.length) throw new Error('progression modifiée entre-temps (relance)');
  }
  console.log('Appliqué.');
}

// Recherche dans les cartes d'un compte (EXTRA = expression régulière, insensible à la casse).
async function grepCards() {
  const t = await userId();
  const re = new RegExp(process.env.EXTRA || '.', 'i');
  const rows = await docsOf(t.id, '&path=like.decks/*');
  rows.filter((r) => r.path !== 'decks/index.json').forEach((r) => {
    const d = JSON.parse(r.content);
    (d.cartes || []).forEach((c) => {
      if (re.test(c.q) || re.test(c.r) || re.test(JSON.stringify(c.choix || ''))) console.log('CARTE ' + r.path + ' #' + c.id + '\n  ' + JSON.stringify(c));
    });
  });
}

try {
  await ({ grep: grepCards, align, modes, 'copy-settings': copySettings, usage, migrate, pull, push, inspect, share, 'copy-decks': copyDecks, reorganize: () => reorganize(false), 'reorganize-apply': () => reorganize(true) })[cmd]();
} catch (e) {
  console.log('Erreur :', e.message);
  process.exit(1);
}
