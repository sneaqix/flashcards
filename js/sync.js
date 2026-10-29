// Synchronisation de la progression avec le dépôt privé, et chargement des cartes.
import { isConflict } from './github.js?v=20261029233129';
import * as S from './store.js?v=20261029233129';
import { $, state, canSync, saveProgress, refreshIfIdle } from './ui.js?v=20261029233129';

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
        return { id: data.id, nom: data.nom, cartes: data.cartes || [], matiere: m.id, matiereNom: m.nom, file, sha };
      } catch (e) {
        console.warn('Chapitre illisible : ' + file, e);
        return null;
      }
    }));
    return { id: m.id, nom: m.nom, chapitres: chapitres.filter(Boolean) };
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
    if (f) { const d = JSON.parse(f.text); ch.cartes = d.cartes || []; ch.sha = f.sha; }
  }
  const cartes = mutate(ch.cartes.map((c) => ({ ...c })));
  const data = { id: ch.id, nom: ch.nom, cartes };
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
