// Synchronisation de la progression avec le dépôt privé, et chargement des cartes.
import { isConflict } from './github.js?v=20261031225520';
import * as S from './store.js?v=20261031225520';
import { $, state, canSync, saveProgress, refreshIfIdle } from './ui.js?v=20261031225520';

export function setChip(kind, detail) {
  const chip = $('syncChip');
  const text = { local: 'Local', busy: 'Synchro…', ok: 'Synchronisé', error: 'Erreur synchro' }[kind];
  chip.textContent = text;
  chip.className = 'chip' + (kind === 'local' ? '' : ' ' + kind);
  chip.title = detail || (kind === 'local' ? 'Progression enregistrée seulement sur cet appareil' : 'Synchroniser maintenant');
}

let syncTimer = null;
export function scheduleSync(delay = 1500) {
  if (!canSync()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; syncNow(); }, delay);
}
export function flushSync() {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; syncNow(); }
}

export async function syncNow(retry = true) {
  if (!canSync()) { setChip('local'); return; }
  if (state.syncing) { state.syncAgain = true; return; }
  state.syncing = true;
  setChip('busy');
  const { gh, config } = state;
  try {
    const remote = await gh.getFile(config.dataRepo, 'progress.json');
    const remoteP = remote ? S.normalize(JSON.parse(remote.text)) : null;
    const merged = remoteP ? S.merge(state.progress, remoteP) : S.normalize(state.progress);
    state.progress = merged;
    saveProgress();
    if (!remoteP || S.stableStringify(merged) !== S.stableStringify(remoteP)) {
      await gh.putFile(config.dataRepo, 'progress.json', JSON.stringify(merged), remote && remote.sha,
        'Sauvegarde de la progression (' + S.deviceId() + ')');
    }
    state.config.lastSync = Date.now();
    S.saveConfig(state.config);
    setChip('ok', 'Dernière synchronisation : ' + new Date().toLocaleTimeString('fr-FR'));
    refreshIfIdle();
  } catch (e) {
    if (retry && isConflict(e)) {
      state.syncing = false;
      await syncNow(false); // l'autre appareil vient d'écrire : on relit et on fusionne
      return;
    }
    setChip('error', e.message);
    console.warn('Synchronisation impossible', e);
  } finally {
    state.syncing = false;
    if (state.syncAgain) { state.syncAgain = false; scheduleSync(500); }
  }
}

// ---------- Cartes ----------
export async function loadDecks() {
  const { gh, config } = state;
  let index = null;
  let viaApi = false;
  if (gh && config.contentRepo) {
    try {
      const f = await gh.getFile(config.contentRepo, 'decks/index.json');
      if (f) { index = JSON.parse(f.text); viaApi = true; }
    } catch (e) { console.warn('Lecture via GitHub impossible, repli sur le site', e); }
  }
  if (!index) {
    const res = await fetch('decks/index.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('index.json introuvable');
    index = await res.json();
  }
  const matieres = await Promise.all(index.matieres.map(async (m) => {
    const chapitres = await Promise.all(m.chapitres.map(async (file) => {
      try {
        let data = null, sha = null;
        if (viaApi) {
          const f = await gh.getFile(config.contentRepo, 'decks/' + file);
          if (f) { data = JSON.parse(f.text); sha = f.sha; }
        } else {
          const res = await fetch('decks/' + file, { cache: 'no-store' });
          if (res.ok) data = await res.json();
        }
        if (!data) return null;
        // meta : informations propres au chapitre (œuvre étudiée, carnet associé…), conservées à l'écriture.
        const { id, nom, cartes, ...meta } = data;
        return { id, nom, cartes: cartes || [], matiere: m.id, matiereNom: m.nom, file, sha, meta };
      } catch (e) {
        console.warn('Chapitre illisible : ' + file, e);
        return null;
      }
    }));
    return { id: m.id, nom: m.nom, carnets: m.carnets || [], chapitres: chapitres.filter(Boolean) };
  }));
  state.matieres = matieres;
  state.chapters = matieres.flatMap((m) => m.chapitres);
  state.byId = new Map(state.chapters.map((c) => [c.id, c]));
}

// Modifie le fichier JSON d'un chapitre sur GitHub, en relisant le fichier en cas de conflit.
export async function updateChapterFile(ch, mutate, message, retry = true) {
  const { gh, config } = state;
  if (!ch.sha) {
    const f = await gh.getFile(config.contentRepo, 'decks/' + ch.file);
    if (f) { const { id, nom, cartes: c, ...meta } = JSON.parse(f.text); ch.cartes = c || []; ch.meta = { ...meta, ...(ch.meta || {}) }; ch.sha = f.sha; }
  }
  const cartes = mutate(ch.cartes.map((c) => ({ ...c })));
  const data = { id: ch.id, nom: ch.nom, ...(ch.meta || {}), cartes };
  try {
    ch.sha = await gh.putFile(config.contentRepo, 'decks/' + ch.file, JSON.stringify(data, null, 2) + '\n', ch.sha, message);
    ch.cartes = cartes;
  } catch (e) {
    if (retry && isConflict(e)) {
      ch.sha = null; // relecture puis nouvelle tentative
      return updateChapterFile(ch, mutate, message, false);
    }
    throw e;
  }
}

function slugify(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}
// Crée un chapitre vide dans le dépôt et l'ajoute à index.json. Renvoie le chapitre.
export async function createChapterFile(mat, nom) {
  const base = slugify(nom);
  if (!base) throw new Error('Donne un nom au chapitre.');
  const sameName = state.chapters.find((c) => c.matiere === mat && c.nom.trim().toLowerCase() === nom.trim().toLowerCase());
  if (sameName) throw new Error('Ce chapitre existe déjà.');
  // Un chapitre renommé garde son identifiant d'origine : on évite qu'un nouveau chapitre le réutilise.
  let slug = base, k = 2;
  while (state.byId.has(mat + '-' + slug)) slug = base + '-' + k++;
  const id = mat + '-' + slug;
  const file = mat + '/' + slug + '.json';
  const { gh, config } = state;
  const sha = await gh.putFile(config.contentRepo, 'decks/' + file,
    JSON.stringify({ id, nom, cartes: [] }, null, 2) + '\n', null, 'Ajoute le chapitre ' + nom);
  for (let attempt = 0; attempt < 2; attempt++) {
    const f = await gh.getFile(config.contentRepo, 'decks/index.json');
    const index = JSON.parse(f.text);
    const m = index.matieres.find((x) => x.id === mat);
    if (!m.chapitres.includes(file)) m.chapitres.push(file);
    try {
      await gh.putFile(config.contentRepo, 'decks/index.json', JSON.stringify(index, null, 2) + '\n', f.sha, 'Ajoute le chapitre ' + nom + ' à l\'index');
      break;
    } catch (e) { if (!isConflict(e) || attempt === 1) throw e; }
  }
  const m = state.matieres.find((x) => x.id === mat);
  const ch = { id, nom, cartes: [], matiere: mat, matiereNom: m.nom, file, sha };
  m.chapitres.push(ch);
  state.chapters = state.matieres.flatMap((x) => x.chapitres);
  state.byId.set(id, ch);
  return ch;
}

// ---------- Gestion des chapitres et matières ----------
// Modifie decks/index.json (relecture et nouvel essai en cas de conflit).
async function updateDeckIndex(mutate, message) {
  const { gh, config } = state;
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = await gh.getFile(config.contentRepo, 'decks/index.json');
    const index = JSON.parse(f.text);
    mutate(index);
    try {
      await gh.putFile(config.contentRepo, 'decks/index.json', JSON.stringify(index, null, 2) + '\n', f.sha, message);
      return index;
    } catch (e) {
      if (!isConflict(e) || attempt === 2) throw e;
    }
  }
}
function refreshChapters() {
  state.chapters = state.matieres.flatMap((m) => m.chapitres);
  state.byId = new Map(state.chapters.map((c) => [c.id, c]));
}

// Crée une matière vide dans decks/index.json. Renvoie son identifiant.
export async function createMatiere(nom) {
  const base = slugify(nom);
  if (!base) throw new Error('Donne un nom à la matière.');
  if (state.matieres.some((m) => m.nom.trim().toLowerCase() === nom.trim().toLowerCase())) throw new Error('Cette matière existe déjà.');
  let id = base, k = 2;
  while (state.matieres.some((m) => m.id === id)) id = base + '-' + k++;
  await updateDeckIndex((index) => {
    if (!index.matieres.some((m) => m.id === id)) index.matieres.push({ id, nom, chapitres: [] });
  }, 'Ajoute la matière ' + nom);
  state.matieres.push({ id, nom, carnets: [], chapitres: [] });
  return id;
}

// Le nouveau nom s'applique partout ; l'identifiant (et donc la progression) ne change pas.
export async function renameChapter(ch, nom) {
  const old = ch.nom;
  ch.nom = nom;
  try {
    await updateChapterFile(ch, (list) => list, 'Renomme le chapitre « ' + old + ' » en « ' + nom + ' »');
  } catch (e) {
    ch.nom = old;
    throw e;
  }
}

export async function renameMatiere(matId, nom) {
  await updateDeckIndex((index) => {
    const m = index.matieres.find((x) => x.id === matId);
    if (m) m.nom = nom;
  }, 'Renomme la matière en « ' + nom + ' »');
  const m = state.matieres.find((x) => x.id === matId);
  m.nom = nom;
  m.chapitres.forEach((c) => { c.matiereNom = nom; });
}

// ids : identifiants des chapitres de la matière, dans le nouvel ordre.
export async function reorderChapters(matId, ids) {
  const m = state.matieres.find((x) => x.id === matId);
  const files = ids.map((id) => m.chapitres.find((c) => c.id === id).file);
  await updateDeckIndex((index) => {
    const im = index.matieres.find((x) => x.id === matId);
    const rest = im.chapitres.filter((f) => !files.includes(f)); // chapitres ajoutés ailleurs entre-temps
    im.chapitres = [...files, ...rest];
  }, 'Réordonne les chapitres de ' + m.nom);
  m.chapitres = ids.map((id) => m.chapitres.find((c) => c.id === id)).concat(m.chapitres.filter((c) => !ids.includes(c.id)));
  refreshChapters();
}

// Supprime un chapitre et ses cartes (les documents du classeur sont gérés à part).
export async function deleteChapter(ch) {
  await updateDeckIndex((index) => {
    const im = index.matieres.find((x) => x.id === ch.matiere);
    if (im) im.chapitres = im.chapitres.filter((f) => f !== ch.file);
  }, 'Retire le chapitre « ' + ch.nom + ' » de l\'index');
  try {
    const f = await state.gh.getFile(state.config.contentRepo, 'decks/' + ch.file);
    if (f) await state.gh.deleteFile(state.config.contentRepo, 'decks/' + ch.file, f.sha, 'Supprime le chapitre « ' + ch.nom + ' »');
  } catch (e) { console.warn('Fichier du chapitre non supprimé', e); }
  const m = state.matieres.find((x) => x.id === ch.matiere);
  m.chapitres = m.chapitres.filter((c) => c.id !== ch.id);
  refreshChapters();
}
