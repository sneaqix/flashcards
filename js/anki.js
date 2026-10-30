// Import et export de paquets Anki (.apkg).
// Bibliothèques hébergées dans vendor/ : JSZip (zip), sql.js (SQLite), fzstd (format récent d'Anki).
import { $, state, newId, setStatus, plural, imageUrl, clozeParts, canEdit } from './ui.js?v=20261030233452';
import { createChapterFile, updateChapterFile } from './sync.js?v=20261030233452';
import { buildChecklist } from './practice.js?v=20261030233452';

// ---------- Bibliothèques ----------
let libs = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Impossible de charger ' + src));
    document.head.appendChild(s);
  });
}
function loadLibs() {
  if (!libs) {
    libs = (async () => {
      if (!window.JSZip) await loadScript('vendor/jszip.min.js');
      if (!window.initSqlJs) await loadScript('vendor/sql-wasm.js');
      const SQL = await window.initSqlJs({ locateFile: (f) => 'vendor/' + f });
      const zstd = await import('../vendor/fzstd.js');
      return { JSZip: window.JSZip, SQL, zstd };
    })();
    libs.catch(() => { libs = null; });
  }
  return libs;
}

const isZstd = (b) => b.length > 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;

// Lecture minimale du format protobuf (paquets Anki récents).
function pbRead(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let v = 0, shift = 0, b;
    do { b = buf[i++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
    return v;
  };
  while (i < buf.length) {
    const key = varint();
    const f = Math.floor(key / 8), wt = key & 7;
    if (wt === 0) out.push({ f, v: varint() });
    else if (wt === 2) { const n = varint(); out.push({ f, v: buf.subarray(i, i + n) }); i += n; }
    else if (wt === 1) i += 8;
    else if (wt === 5) i += 4;
    else break;
  }
  return out;
}
const utf8 = (b) => new TextDecoder().decode(b);

function rows(db, sql) {
  const res = db.exec(sql);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}
const hasTable = (db, name) => rows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='" + name + "'").length > 0;

// ---------- Conversion du HTML d'Anki en texte de carte ----------
function decodeEntities(s) {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}
// Renvoie { text, imgs } : texte brut (LaTeX entre $…$) et noms des images rencontrées.
export function htmlToText(html) {
  const imgs = [];
  let s = String(html || '')
    .replace(/<img[^>]*src=["']?([^"' >]+)["']?[^>]*>/gi, (m, src) => { imgs.push(decodeEntities(src)); return ''; })
    .replace(/\[sound:[^\]]*\]/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|tr|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s)
    .replace(/\u00a0/g, ' ')
    .replace(/\\\[([\s\S]*?)\\\]/g, (m, x) => '$$' + x + '$$')
    .replace(/\\\(([\s\S]*?)\\\)/g, (m, x) => '$' + x + '$')
    .replace(/\[\$\$\]([\s\S]*?)\[\/\$\$\]/g, (m, x) => '$$' + x + '$$')
    .replace(/\[\$\]([\s\S]*?)\[\/\$\]/g, (m, x) => '$' + x + '$')
    .replace(/\[latex\]([\s\S]*?)\[\/latex\]/g, (m, x) => '$$' + x.trim() + '$$')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: s, imgs };
}

// Remplit un modèle de carte Anki ({{Champ}}, {{#Champ}}…{{/Champ}}, {{type:Champ}}…).
function render(tpl, fields, front = '') {
  let s = String(tpl || '');
  for (let k = 0; k < 5; k++) {
    const before = s;
    s = s.replace(/\{\{([#^])\s*([^}]+?)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g, (m, op, name, inner) => {
      const v = (fields[name] || '').replace(/<[^>]+>/g, '').trim();
      return (op === '#' ? v : !v) ? inner : '';
    });
    if (s === before) break;
  }
  return s.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, name) => {
    if (name === 'FrontSide') return front;
    const parts = name.split(':');
    const field = parts[parts.length - 1].trim();
    const filters = parts.slice(0, -1).map((x) => x.trim());
    if (filters.includes('type')) return '';
    if (filters.some((f) => f === 'tts')) return '';
    return fields[field] || '';
  });
}
// Verso : seulement ce qui suit la ligne <hr id=answer> quand il y en a une.
function answerPart(html) {
  const parts = String(html || '').split(/<hr id=["']?answer["']?\s*\/?>/i);
  return parts.length > 1 ? parts.slice(1).join('') : html;
}

// {{c1::réponse::indice}} → {{réponse::indice}} (tous les trous d'une note sur une même carte).
function convertCloze(text) {
  return text.replace(/\{\{c\d+::([\s\S]*?)\}\}/g, (m, inner) => '{{' + inner.replace(/\}\s*$/, '') + '}}');
}

// ---------- Lecture d'un paquet ----------
// Renvoie { decks: [{ path, cards }], media: Map(nom -> octets), skipped }.
export async function readApkg(file) {
  const { JSZip, SQL, zstd } = await loadLibs();
  const zip = await JSZip.loadAsync(file);
  const pick = ['collection.anki21b', 'collection.anki21', 'collection.anki2'].find((n) => zip.file(n));
  if (!pick) throw new Error('Ce fichier n\'est pas un paquet Anki (.apkg).');
  let bytes = await zip.file(pick).async('uint8array');
  if (isZstd(bytes)) bytes = zstd.decompress(bytes);
  const db = new SQL.Database(bytes);
  try {
    // Types de notes
    const models = new Map(); // id -> { name, cloze, fields: [noms], tmpls: [{ q, a }] }
    if (hasTable(db, 'notetypes')) {
      rows(db, 'SELECT id, name, config FROM notetypes').forEach((r) => {
        const kind = pbRead(r.config || new Uint8Array()).find((x) => x.f === 1);
        models.set(String(r.id), { name: r.name, cloze: !!(kind && kind.v === 1), fields: [], tmpls: [] });
      });
      rows(db, 'SELECT ntid, ord, name FROM fields ORDER BY ntid, ord').forEach((r) => { const m = models.get(String(r.ntid)); if (m) m.fields[r.ord] = r.name; });
      rows(db, 'SELECT ntid, ord, config FROM templates ORDER BY ntid, ord').forEach((r) => {
        const m = models.get(String(r.ntid));
        if (!m) return;
        const pb = pbRead(r.config || new Uint8Array());
        const str = (f) => { const x = pb.find((y) => y.f === f); return x ? utf8(x.v) : ''; };
        m.tmpls[r.ord] = { q: str(1), a: str(2) };
      });
    } else {
      const col = rows(db, 'SELECT models, decks FROM col')[0];
      Object.values(JSON.parse(col.models)).forEach((m) => {
        models.set(String(m.id), {
          name: m.name, cloze: m.type === 1,
          fields: m.flds.slice().sort((a, b) => a.ord - b.ord).map((f) => f.name),
          tmpls: m.tmpls.slice().sort((a, b) => a.ord - b.ord).map((t) => ({ q: t.qfmt, a: t.afmt })),
        });
      });
    }
    // Paquets
    const deckNames = new Map();
    if (hasTable(db, 'decks')) rows(db, 'SELECT id, name FROM decks').forEach((r) => deckNames.set(String(r.id), r.name.split('\x1f').join('::')));
    else Object.values(JSON.parse(rows(db, 'SELECT decks FROM col')[0].decks)).forEach((d) => deckNames.set(String(d.id), d.name));

    // Médias
    const media = new Map();
    const mf = zip.file('media');
    if (mf) {
      let raw = await mf.async('uint8array');
      let names = null;
      if (isZstd(raw)) raw = zstd.decompress(raw);
      try { names = Object.entries(JSON.parse(utf8(raw))); } catch (e) {
        names = pbRead(raw).filter((x) => x.f === 1).map((x, i) => {
          const entry = pbRead(x.v);
          const n = entry.find((y) => y.f === 1);
          const legacy = entry.find((y) => y.f === 255);
          return [String(legacy ? legacy.v : i), n ? utf8(n.v) : ''];
        });
      }
      for (const [idx, name] of names) {
        const f = zip.file(idx);
        if (!f || !name) continue;
        media.set(name, { file: f, zstd });
      }
    }

    // Notes et cartes
    const notes = new Map(rows(db, 'SELECT id, mid, flds FROM notes').map((n) => [String(n.id), n]));
    const byNote = new Map();
    rows(db, 'SELECT nid, did, ord FROM cards ORDER BY nid, ord').forEach((c) => {
      const k = String(c.nid);
      if (!byNote.has(k)) byNote.set(k, { did: String(c.did), ords: [] });
      byNote.get(k).ords.push(c.ord);
    });
    const decks = new Map();
    let skipped = 0;
    const norm = (x) => x.replace(/\s+/g, ' ').trim();
    for (const [nid, info] of byNote) {
      const n = notes.get(nid);
      const m = n && models.get(String(n.mid));
      if (!m) { skipped++; continue; }
      const vals = n.flds.split('\x1f');
      const fields = Object.fromEntries(m.fields.map((name, i) => [name, vals[i] || '']));
      const out = [];
      const make = (qHtml, aHtml) => {
        const q = htmlToText(qHtml), a = htmlToText(aHtml);
        const card = { q: q.text, r: a.text };
        if (q.imgs[0]) card._img_q = q.imgs[0];
        if (a.imgs[0]) card._img_r = a.imgs[0];
        return card;
      };
      if (m.cloze) {
        const main = m.fields[0];
        const card = make(convertCloze(fields[main] || ''), m.fields.slice(1).map((f) => fields[f]).filter((v) => v && v.trim()).join('<br>'));
        if (card.q.includes('{{')) { card.mode = 'trou'; out.push(card); } else skipped++;
      } else {
        const t = m.tmpls;
        const typed = (t[0] && (t[0].q.match(/\{\{type:([^}]+)\}\}/) || [])[1]) || null;
        const q0 = render(t[0].q, fields);
        const a0 = answerPart(render(t[0].a, fields, ''));
        const card = make(q0, a0);
        if (typed) { card.mode = 'saisie'; card.attendu = htmlToText(fields[typed.trim()] || '').text; if (!card.r) card.r = card.attendu; }
        if (t[1] && info.ords.includes(1)) {
          const q1 = render(t[1].q, fields), a1 = answerPart(render(t[1].a, fields, ''));
          if (norm(htmlToText(q1).text) === norm(card.r) && norm(htmlToText(a1).text) === norm(card.q)) card.inverse = true;
          else out.push(make(q1, a1));
        }
        if (card.q) out.unshift(card); else skipped++;
        // Autres modèles de carte (au-delà de deux) : une carte chacun.
        t.slice(2).forEach((tpl, k) => { if (info.ords.includes(k + 2)) out.push(make(render(tpl.q, fields), answerPart(render(tpl.a, fields, '')))); });
      }
      const path = deckNames.get(info.did) || 'Anki';
      if (!decks.has(path)) decks.set(path, []);
      decks.get(path).push(...out.filter((c) => c.q));
    }
    return { decks: [...decks].map(([path, cards]) => ({ path, cards })).filter((d) => d.cards.length).sort((a, b) => a.path.localeCompare(b.path, 'fr', { numeric: true })), media, skipped };
  } finally {
    db.close();
  }
}

async function mediaBytes(entry) {
  let b = await entry.file.async('uint8array');
  if (isZstd(b)) b = entry.zstd.decompress(b);
  return b;
}
function bytesToBase64(b) {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- Écran d'import (Réglages) ----------
let pending = null; // { decks, media, name }

function chapterNames(decks) {
  // Nom de chapitre : chemin du sous-paquet sans la racine commune.
  const parts = decks.map((d) => d.path.split('::'));
  let common = 0;
  if (parts.length > 1) {
    while (parts.every((p) => p.length > common + 1 && p[common] === parts[0][common])) common++;
  } else common = Math.max(0, parts[0].length - 1);
  return parts.map((p) => p.slice(common).join(' – '));
}

function renderPreview() {
  const box = $('ankiPreview');
  box.innerHTML = '';
  if (!pending) { box.hidden = true; return; }
  box.hidden = false;
  const names = chapterNames(pending.decks);
  const total = pending.decks.reduce((n, d) => n + d.cards.length, 0);
  const head = document.createElement('p');
  head.className = 'sub';
  head.textContent = plural(total, 'carte', 'cartes') + ' dans ' + plural(pending.decks.length, 'sous-paquet', 'sous-paquets') +
    (pending.skipped ? ' · ' + pending.skipped + ' note(s) ignorée(s)' : '') + '. Chaque sous-paquet coché devient un chapitre (nom modifiable) ; si un chapitre de la matière porte déjà ce nom, les cartes y sont ajoutées.';
  box.appendChild(head);
  pending.decks.forEach((d, i) => {
    const row = document.createElement('div');
    row.className = 'anki-deck';
    row.innerHTML = '<input type="checkbox" checked><input type="text" class="anki-name" aria-label="Nom du chapitre"><span class="anki-n"></span><p class="anki-ex"></p>';
    const [check, name] = row.querySelectorAll('input');
    check.setAttribute('aria-label', 'Importer ' + d.path);
    name.value = names[i] || d.path;
    row.querySelector('.anki-n').textContent = plural(d.cards.length, 'carte', 'cartes');
    const ex = d.cards[0];
    row.querySelector('.anki-ex').textContent = 'Ex. : ' + (ex.mode === 'trou' ? ex.q.replace(/\{\{(.+?)(::.*?)?\}\}/g, '[…]') : ex.q).slice(0, 120);
    d.ui = { check, name };
    box.appendChild(row);
  });
  const bar = document.createElement('div');
  bar.className = 'row';
  bar.innerHTML = '<button type="button" class="primary" id="ankiGo">Importer</button><button type="button" class="ghost" id="ankiCancel">Annuler</button>';
  box.appendChild(bar);
  $('ankiGo').addEventListener('click', doImport);
  $('ankiCancel').addEventListener('click', () => { pending = null; renderPreview(); setStatus('ankiStatus', ''); });
}

async function pickFile(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  pending = null;
  renderPreview();
  setStatus('ankiStatus', 'Lecture du paquet…');
  try {
    const res = await readApkg(file);
    if (!res.decks.length) throw new Error('Aucune carte lisible dans ce paquet.');
    pending = { ...res, name: file.name };
    setStatus('ankiStatus', '');
    renderPreview();
  } catch (e) {
    console.warn(e);
    setStatus('ankiStatus', 'Import impossible : ' + e.message, 'error');
  }
}

async function doImport() {
  if (!pending) return;
  if (!canEdit()) { setStatus('ankiStatus', 'Configure d\'abord la synchronisation GitHub pour pouvoir ajouter des chapitres.', 'error'); return; }
  const mat = $('ankiMat').value;
  const chosen = pending.decks.filter((d) => d.ui.check.checked && d.ui.name.value.trim());
  if (!chosen.length) { setStatus('ankiStatus', 'Coche au moins un sous-paquet.', 'error'); return; }
  $('ankiGo').disabled = true;
  const uploaded = new Map(); // nom Anki -> chemin dans le dépôt
  let nCards = 0, nImg = 0, missing = 0;
  try {
    for (const d of chosen) {
      const nom = d.ui.name.value.trim();
      setStatus('ankiStatus', 'Import de « ' + nom + ' »…');
      const cards = [];
      for (const c of d.cards) {
        const card = { id: newId() + Math.random().toString(36).slice(2, 4), q: c.q, r: c.r };
        ['mode', 'attendu', 'inverse'].forEach((k) => { if (c[k]) card[k] = c[k]; });
        for (const side of ['q', 'r']) {
          const name = c['_img_' + side];
          if (!name) continue;
          const entry = pending.media.get(name);
          if (!entry) { missing++; continue; }
          if (!uploaded.has(name)) {
            const ext = (name.match(/\.(png|jpe?g|gif|webp|svg)$/i) || [, 'png'])[1].toLowerCase();
            const path = 'images/anki-' + newId() + '.' + ext;
            const b = await mediaBytes(entry);
            await state.gh.putFile(state.config.contentRepo, path, bytesToBase64(b), null, 'Image importée d\'Anki', true);
            state.imgCache.set(path, URL.createObjectURL(new Blob([b], { type: ext === 'svg' ? 'image/svg+xml' : 'image/' + (ext === 'jpg' ? 'jpeg' : ext) })));
            uploaded.set(name, path);
            nImg++;
          }
          card['img_' + side] = uploaded.get(name);
        }
        cards.push(card);
      }
      let ch = state.chapters.find((x) => x.matiere === mat && x.nom.trim().toLowerCase() === nom.toLowerCase());
      if (!ch) ch = await createChapterFile(mat, nom);
      await updateChapterFile(ch, (list) => list.concat(cards), 'Import Anki : ' + nom);
      nCards += cards.length;
    }
    pending = null;
    renderPreview();
    setStatus('ankiStatus', plural(nCards, 'carte importée', 'cartes importées') + (nImg ? ', ' + plural(nImg, 'image', 'images') : '') +
      (missing ? ' (' + missing + ' image(s) introuvable(s) dans le paquet)' : '') + '. Les chapitres sont dans l\'onglet Cartes.', 'ok');
  } catch (e) {
    console.warn(e);
    setStatus('ankiStatus', 'Import interrompu : ' + e.message + (nCards ? ' (' + nCards + ' cartes déjà ajoutées)' : ''), 'error');
    const go = $('ankiGo');
    if (go) go.disabled = false;
  }
}

// ---------- Export ----------
const exportSel = new Set();

function textToHtml(text, cloze = false) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let s = String(text || '');
  if (cloze) {
    s = clozeParts(s).map((p) => (p.answer === undefined ? p.text : '{{c1::' + p.answer + (p.hint ? '::' + p.hint : '') + '}}')).join('');
  }
  // Formules : $$…$$ → \[…\], $…$ → \(…\) (rendu MathJax d'Anki).
  const chunks = [];
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (m, x) => { chunks.push('\\[' + esc(x) + '\\]'); return '\u0000' + (chunks.length - 1) + '\u0000'; })
    .replace(/\$([^$\n]+?)\$/g, (m, x) => { chunks.push('\\(' + esc(x) + '\\)'); return '\u0000' + (chunks.length - 1) + '\u0000'; });
  s = esc(s).replace(/\n/g, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => chunks[+i]);
}

async function sha1Int(text) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)));
  return ((h[0] << 24) >>> 0) + (h[1] << 16) + (h[2] << 8) + h[3];
}
function guidOf(key) {
  // Identifiant stable : réexporter met à jour les notes déjà importées au lieu de les dupliquer.
  let h1 = 0x811c9dc5, h2 = 0x1234567;
  for (let i = 0; i < key.length; i++) { h1 = Math.imul(h1 ^ key.charCodeAt(i), 16777619); h2 = Math.imul(h2 + key.charCodeAt(i), 2654435761); }
  return 'fc' + (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

const CSS = '.card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; }\n.cloze { font-weight: bold; color: blue; }\n.nightMode .cloze { color: lightblue; }';
const LATEX_PRE = '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n';
function model(id, name, type, fields, tmpls, now) {
  return {
    id, name, type, mod: now, usn: -1, sortf: 0, did: 1, css: CSS, latexPre: LATEX_PRE, latexPost: '\\end{document}', latexsvg: false, tags: [], vers: [],
    flds: fields.map((f, i) => ({ name: f, ord: i, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] })),
    tmpls: tmpls.map(([n, q, a], i) => ({ name: n, ord: i, qfmt: q, afmt: a, did: null, bqfmt: '', bafmt: '' })),
    req: type === 1 ? [] : tmpls.map((t, i) => [i, 'any', [i]]),
  };
}

export async function buildApkg(chapters, onProgress = () => {}) {
  const { JSZip, SQL } = await loadLibs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn); CREATE INDEX ix_cards_usn on cards (usn); CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid); CREATE INDEX ix_cards_sched on cards (did, queue, due); CREATE INDEX ix_revlog_cid on revlog (cid); CREATE INDEX ix_notes_csum on notes (csum);`);
  const nowMs = Date.now(), now = Math.floor(nowMs / 1000);
  const MID = { base: 1700000000101, inv: 1700000000102, trou: 1700000000103 };
  const models = {
    [MID.base]: model(MID.base, 'Flashcards prépa · Base', 0, ['Recto', 'Verso'], [['Carte 1', '{{Recto}}', '{{FrontSide}}\n\n<hr id=answer>\n\n{{Verso}}']], now),
    [MID.inv]: model(MID.inv, 'Flashcards prépa · Base et inversée', 0, ['Recto', 'Verso'], [
      ['Carte 1', '{{Recto}}', '{{FrontSide}}\n\n<hr id=answer>\n\n{{Verso}}'],
      ['Carte 2', '{{Verso}}', '{{FrontSide}}\n\n<hr id=answer>\n\n{{Recto}}']], now),
    [MID.trou]: model(MID.trou, 'Flashcards prépa · Texte à trous', 1, ['Texte', 'Extra'], [['Texte à trous', '{{cloze:Texte}}', '{{cloze:Texte}}<br>\n{{Extra}}']], now),
  };
  const decks = { 1: { id: 1, name: 'Default', mod: now, usn: -1, lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0], collapsed: true, browserCollapsed: true, desc: '', dyn: 0, conf: 1, extendNew: 0, extendRev: 0 } };
  let deckSeq = 1700000001000;
  const deckId = (name) => {
    const found = Object.values(decks).find((d) => d.name === name);
    if (found) return found.id;
    const id = deckSeq++;
    decks[id] = { ...decks[1], id, name, collapsed: false, browserCollapsed: false };
    return id;
  };
  const media = []; // [nom dans le paquet, octets]
  const mediaOf = new Map();
  const addImg = async (path) => {
    if (!path) return '';
    if (!mediaOf.has(path)) {
      try {
        const res = await fetch(imageUrl(path));
        if (!res.ok) throw new Error(res.status);
        const name = 'fc-' + path.split('/').pop();
        media.push([name, new Uint8Array(await res.arrayBuffer())]);
        mediaOf.set(path, name);
      } catch (e) { mediaOf.set(path, null); }
    }
    const n = mediaOf.get(path);
    return n ? '<br><img src="' + n + '">' : '';
  };
  let nid = nowMs, cid = nowMs, due = 0, nNotes = 0;
  const insNote = db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const insCard = db.prepare('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const ch of chapters) {
    onProgress(ch.nom);
    const root = 'Flashcards prépa';
    const did = deckId(root);
    deckId(root + '::' + ch.matiereNom);
    const chDid = deckId(root + '::' + ch.matiereNom + '::' + ch.nom);
    void did;
    for (const c of ch.cartes) {
      const cloze = c.mode === 'trou';
      const mid = cloze ? MID.trou : c.inverse ? MID.inv : MID.base;
      const f1 = textToHtml(c.q, cloze) + await addImg(c.img_q);
      const f2 = textToHtml(c.r) + await addImg(c.img_r);
      const sfld = f1.replace(/<[^>]+>/g, '');
      nid++;
      insNote.run([nid, guidOf(ch.id + '/' + c.id), mid, now, -1, '', f1 + '\x1f' + f2, sfld, await sha1Int(sfld), 0, '']);
      const ords = mid === MID.inv ? [0, 1] : [0];
      for (const ord of ords) insCard.run([++cid, nid, chDid, ord, now, -1, 0, 0, ++due, 0, 0, 0, 0, 0, 0, 0, 0, '']);
      nNotes++;
    }
  }
  insNote.free();
  insCard.free();
  const conf = { nextPos: due + 1, estTimes: true, activeDecks: [1], sortType: 'noteFld', timeLim: 0, sortBackwards: false, addToCur: true, curDeck: 1, newBury: true, newSpread: 0, dueCounts: true, curModel: String(MID.base), collapseTime: 1200 };
  const dconf = { 1: { id: 1, name: 'Default', replayq: true, lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 0 }, rev: { perDay: 200, ease4: 1.3, fuzz: 0.05, minSpace: 1, ivlFct: 1, maxIvl: 36500, bury: false, hardFactor: 1.2 }, timer: 0, maxTaken: 60, usn: 0, new: { delays: [1, 10], ints: [1, 4, 7], initialFactor: 2500, separate: true, order: 1, perDay: 20, bury: false }, mod: 0, autoplay: true, dyn: false } };
  db.run('INSERT INTO col VALUES (1,?,?,?,11,0,0,0,?,?,?,?,?)', [now - (now % 86400), nowMs, nowMs, JSON.stringify(conf), JSON.stringify(models), JSON.stringify(decks), JSON.stringify(dconf), '{}']);
  const data = db.export();
  db.close();
  const zip = new JSZip();
  zip.file('collection.anki2', data);
  const index = {};
  media.forEach(([name, b], i) => { index[i] = name; zip.file(String(i), b); });
  zip.file('media', JSON.stringify(index));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return { blob, notes: nNotes, images: media.length };
}

async function doExport() {
  const chapters = state.chapters.filter((c) => exportSel.has(c.id) && c.cartes.length);
  if (!chapters.length) { setStatus('ankiXStatus', 'Coche au moins un chapitre.', 'error'); return; }
  $('ankiExport').disabled = true;
  try {
    const { blob, notes, images } = await buildApkg(chapters, (n) => setStatus('ankiXStatus', 'Préparation de « ' + n + ' »…'));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'flashcards-prepa-' + new Date().toISOString().slice(0, 10) + '.apkg';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    setStatus('ankiXStatus', plural(notes, 'carte exportée', 'cartes exportées') + (images ? ', ' + plural(images, 'image', 'images') : '') + '. Ouvre le fichier avec Anki.', 'ok');
  } catch (e) {
    console.warn(e);
    setStatus('ankiXStatus', 'Export impossible : ' + e.message, 'error');
  } finally {
    $('ankiExport').disabled = false;
  }
}

export function renderAnki() {
  const sel = $('ankiMat');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = state.matieres.map((m) => '<option value="' + m.id + '">' + m.nom + '</option>').join('');
  if (cur) sel.value = cur;
  buildChecklist($('ankiChapters'), (ch) => exportSel.has(ch.id), (chs, on) => {
    chs.forEach((ch) => (on ? exportSel.add(ch.id) : exportSel.delete(ch.id)));
    updateExportCount();
  });
  updateExportCount();
  renderPreview();
}
function updateExportCount() {
  const n = state.chapters.filter((c) => exportSel.has(c.id)).reduce((s, c) => s + c.cartes.length, 0);
  $('ankiExport').textContent = n ? 'Exporter ' + plural(n, 'carte', 'cartes') + ' (.apkg)' : 'Exporter (.apkg)';
}

export function bindAnki() {
  if (!$('ankiFile')) return;
  $('ankiFile').addEventListener('change', (e) => pickFile(e.target));
  $('ankiExport').addEventListener('click', doExport);
}
