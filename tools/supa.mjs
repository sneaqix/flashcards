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
if (!['migrate', 'pull', 'push', 'inspect', 'reorganize', 'reorganize-apply', 'share'].includes(cmd) || !username) { console.log('Usage : migrate|pull|push <appli> <données> <identifiant>'); process.exit(1); }
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
const DATA_DOCS = (f) => /^(progress|agenda)\.json$/.test(f) || /^(carnets|classeur|edt|notifications)\/.+\.json$/.test(f);
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
async function share() {
  const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'edt/share.json'), 'utf8')); } catch (e) { return null; } })();
  const list = (cfg && cfg.recipients) || [];
  if (!list.length) { console.log('Aucun compte avec qui partager.'); return; }
  const edt = fs.readFileSync(path.join(dataDir, 'edt/edt.json'), 'utf8');
  const mine = JSON.parse(fs.readFileSync(path.join(dataDir, 'agenda.json'), 'utf8'));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
  const shared = (mine.items || []).filter((it) => (it.src === 'colloscope' || it.src === 'ent') && !it.done && (it.date || '') >= today);
  for (const name of list) {
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
      if (!add.length) { console.log(name + ' : emploi du temps copié, calendrier déjà à jour.'); break; }
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

try {
  await ({ migrate, pull, push, inspect, share, reorganize: () => reorganize(false), 'reorganize-apply': () => reorganize(true) })[cmd]();
} catch (e) {
  console.log('Erreur :', e.message);
  process.exit(1);
}
