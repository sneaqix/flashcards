// Onglet Réglages.
import { GitHub } from './github.js?v=20261029233129';
import * as S from './store.js?v=20261029233129';
import { $, state, setStatus, plural, saveProgress, canSync } from './ui.js?v=20261029233129';
import { scheduleSync, syncNow, setChip, loadDecks } from './sync.js?v=20261029233129';
import { buildChecklist } from './practice.js?v=20261029233129';

export function renderSettings() {
  const s = state.progress.settings;
  renderSubjectLimits();
  $('sRetention').value = String(Math.round(s.retention * 100));
  $('sMaxIvl').value = s.maxIvl;
  $('sLearn').value = (s.learnSteps || []).join(' ');
  $('sRelearn').value = (s.relearnSteps || []).join(' ');
  const off = new Set(s.inactive || []);
  buildChecklist($('activeChapters'), (ch) => !off.has(ch.id), (chs, on) => {
    const set = new Set(state.progress.settings.inactive || []);
    chs.forEach((ch) => (on ? set.delete(ch.id) : set.add(ch.id)));
    updateSettings({ inactive: [...set] });
  });
  $('gToken').value = state.config.token ? state.config.token : '';
  $('gContent').value = state.config.contentRepo || guessContentRepo();
  $('gData').value = state.config.dataRepo || ($('gContent').value ? $('gContent').value + '-data' : '');
  const last = state.config.lastSync ? new Date(state.config.lastSync).toLocaleString('fr-FR') : null;
  if (!$('gStatus').textContent) setStatus('gStatus', canSync() ? 'Dernière synchronisation : ' + (last || 'jamais') : 'Synchronisation non configurée.');
}

// Tableau des limites quotidiennes : une ligne par matière, nouvelles cartes et révisions maximum.
function renderSubjectLimits() {
  const box = $('subjectLimits');
  box.innerHTML = '<span></span><span class="lh">Nouvelles</span><span class="lh">Révisions</span>';
  state.matieres.forEach((m) => {
    const lim = S.subjectLimits(state.progress.settings, m.id);
    const name = document.createElement('span');
    name.className = 'ln';
    name.textContent = m.nom;
    box.appendChild(name);
    [['newPerDay', 500, 'nouvelles cartes par jour'], ['maxReviews', 2000, 'révisions maximum par jour']].forEach(([field, max, label]) => {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = String(max);
      input.inputMode = 'numeric';
      input.id = 'lim-' + m.id + '-' + field;
      input.value = lim[field];
      input.setAttribute('aria-label', m.nom + ' : ' + label);
      input.addEventListener('change', () => {
        const current = S.subjectLimits(state.progress.settings, m.id);
        const v = readNumber(input.id, 0, max, current[field]);
        input.value = v;
        const subjects = { ...(state.progress.settings.subjects || {}) };
        subjects[m.id] = { ...current, [field]: v };
        updateSettings({ subjects });
        updateLimitsTotal();
      });
      box.appendChild(input);
    });
  });
  updateLimitsTotal();
}
function updateLimitsTotal() {
  const s = state.progress.settings;
  let nw = 0, rv = 0, unlimited = false;
  state.matieres.forEach((m) => {
    const lim = S.subjectLimits(s, m.id);
    nw += lim.newPerDay;
    if (lim.maxReviews === 0) unlimited = true; else rv += lim.maxReviews;
  });
  $('limitsTotal').textContent = 'Total par jour : ' + plural(nw, 'nouvelle carte', 'nouvelles cartes') + ' et ' +
    (unlimited ? 'des révisions sans limite pour au moins une matière.' : 'au plus ' + plural(rv, 'révision', 'révisions') + '.');
}
// Sur GitHub Pages, l'adresse pseudo.github.io/depot donne le dépôt du site.
function guessContentRepo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return m && repo ? m[1] + '/' + repo : '';
}
function updateSettings(patch, statusId = 'sStatus') {
  state.progress.settings = { ...state.progress.settings, ...patch, updated: Date.now() };
  saveProgress();
  setStatus(statusId, 'Réglages enregistrés.', 'ok');
  scheduleSync(2000);
}
function readNumber(id, min, max, fallback) {
  const v = Math.round(Number($(id).value));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}
function readSteps(id, fallback) {
  const raw = $(id).value.trim();
  if (!raw) return [];
  const steps = raw.split(/[\s,;]+/).map(Number).filter((x) => Number.isFinite(x) && x > 0 && x <= 1440);
  return steps.length ? steps.slice(0, 6) : fallback;
}

async function saveGitHubConfig() {
  const token = $('gToken').value.trim();
  const contentRepo = $('gContent').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
  const dataRepo = $('gData').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(contentRepo) || !/^[\w.-]+\/[\w.-]+$/.test(dataRepo)) {
    setStatus('gStatus', 'Renseigne le jeton et les deux dépôts sous la forme pseudo/depot.', 'error');
    return;
  }
  $('gSave').disabled = true;
  setStatus('gStatus', 'Vérification de l\'accès…');
  const gh = new GitHub(token);
  try {
    const site = await gh.checkRepo(contentRepo);
    const data = await gh.checkRepo(dataRepo);
    const problems = [];
    if (!site.canWrite) problems.push('le jeton ne peut pas écrire dans ' + contentRepo + ' (l\'éditeur de cartes ne marchera pas)');
    if (!data.canWrite) problems.push('le jeton ne peut pas écrire dans ' + dataRepo);
    if (!data.private) problems.push(dataRepo + ' est public : ta progression sera visible de tous');
    state.config = { ...state.config, token, contentRepo, dataRepo };
    S.saveConfig(state.config);
    state.gh = gh;
    setStatus('gStatus', problems.length ? 'Enregistré, mais ' + problems.join(' ; ') + '.' : 'Accès vérifié. Synchronisation…', problems.length ? 'error' : 'ok');
    await loadDecks().catch(() => {});
    await syncNow();
    if (!problems.length) setStatus('gStatus', 'Synchronisé avec ' + dataRepo + '.', 'ok');
  } catch (e) {
    const msg = e.status === 401 ? 'Jeton refusé par GitHub (invalide ou expiré).'
      : e.status === 404 ? 'Dépôt introuvable, ou le jeton n\'y a pas accès.'
      : e.message;
    setStatus('gStatus', msg, 'error');
  } finally {
    $('gSave').disabled = false;
  }
}
function forgetToken() {
  state.config = { ...state.config, token: '' };
  S.saveConfig(state.config);
  state.gh = null;
  $('gToken').value = '';
  setChip('local');
  setStatus('gStatus', 'Jeton supprimé de cet appareil. La progression reste enregistrée localement.');
}
function exportProgress() {
  const blob = new Blob([JSON.stringify(state.progress, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'flashcards-progression-' + S.today() + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  setStatus('xStatus', 'Fichier exporté.', 'ok');
}
async function importProgress(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data.cards !== 'object') throw new Error();
    state.progress = S.merge(state.progress, data);
    saveProgress();
    setStatus('xStatus', 'Progression importée et fusionnée avec celle de cet appareil.', 'ok');
    scheduleSync(0);
  } catch (e) {
    setStatus('xStatus', 'Ce fichier n\'est pas une sauvegarde de progression valide.', 'error');
  }
}

export function bindSettings() {
  $('sRetention').addEventListener('change', () => updateSettings({ retention: Number($('sRetention').value) / 100 }, 'algoStatus'));
  $('sMaxIvl').addEventListener('change', () => {
    const v = readNumber('sMaxIvl', 7, 3650, state.progress.settings.maxIvl);
    $('sMaxIvl').value = v;
    updateSettings({ maxIvl: v }, 'algoStatus');
  });
  $('sLearn').addEventListener('change', () => {
    const v = readSteps('sLearn', state.progress.settings.learnSteps);
    $('sLearn').value = v.join(' ');
    updateSettings({ learnSteps: v }, 'algoStatus');
  });
  $('sRelearn').addEventListener('change', () => {
    const v = readSteps('sRelearn', state.progress.settings.relearnSteps);
    $('sRelearn').value = v.join(' ');
    updateSettings({ relearnSteps: v }, 'algoStatus');
  });
  $('gSave').addEventListener('click', saveGitHubConfig);
  $('gForget').addEventListener('click', forgetToken);
  $('exportBtn').addEventListener('click', exportProgress);
  $('importFile').addEventListener('change', (e) => importProgress(e.target));
}
