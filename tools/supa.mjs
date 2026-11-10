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
if (!['migrate', 'pull', 'push', 'inspect'].includes(cmd) || !username) { console.log('Usage : migrate|pull|push <appli> <données> <identifiant>'); process.exit(1); }
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

try {
  await ({ migrate, pull, push, inspect })[cmd]();
} catch (e) {
  console.log('Erreur :', e.message);
  process.exit(1);
}
