// Onglet Réglages.
import { GitHub } from './github.js?v=20261031181747';
import * as S from './store.js?v=20261031181747';
import { $, state, setStatus, plural, saveProgress, canSync, dailyOff } from './ui.js?v=20261031181747';
import { renderAppearance, themeLabel } from './theme.js?v=20261031181747';
import { renderEdtSettings, edtSummary } from './edt.js?v=20261031181747';
import { renderAnki, bindAnki } from './anki.js?v=20261031181747';
import { renderNotifs, notifSummary } from './notifs.js?v=20261031181747';
import { scheduleSync, syncNow, setChip, loadDecks } from './sync.js?v=20261031181747';
import { MODELS, DEFAULT_MODEL } from './gemini.js?v=20261031181747';
import { PALETTE, matColorKey } from './agenda.js?v=20261031181747';
import { buildChecklist } from './practice.js?v=20261031181747';

export function renderSettings() {
  const s = state.progress.settings;
  renderSubjectLimits();
  renderMatColors();
  renderNotifs();
  renderAppearance();
  renderAnki();
  renderEdtSettings();
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
  $('gemKey').value = state.config.geminiKey || '';
  $('gemModel').innerHTML = MODELS.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('');
  $('gemModel').value = state.config.geminiModel || DEFAULT_MODEL;
  $('gToken').value = state.config.token ? state.config.token : '';
  $('gContent').value = state.config.contentRepo || guessContentRepo();
  $('gData').value = state.config.dataRepo || ($('gContent').value ? $('gContent').value + '-data' : '');
  const last = state.config.lastSync ? new Date(state.config.lastSync).toLocaleString('fr-FR') : null;
  if (!$('gStatus').textContent) setStatus('gStatus', canSync() ? 'Dernière synchronisation : ' + (last || 'jamais') : 'Synchronisation non configurée.');
  renderSummaries();
}

// ---------- Sections dépliables ----------
// Une seule section ouverte à la fois ; chaque titre affiche un résumé de l'état actuel.
function renderSummaries() {
  const s = state.progress.settings;
  const set = (key, text) => { const el = $('sum-' + key); if (el) el.textContent = text; };
  const nouvelles = state.matieres.reduce((n, m) => n + S.subjectLimits(s, m.id).newPerDay, 0);
  const off = state.matieres.filter((m) => dailyOff().has(m.id)).map((m) => m.nom);
  set('rythme', nouvelles + ' nouvelles/jour' + (off.length ? ' · ' + off.join(', ') + ' à part' : ''));
  set('planif', 'Rétention ' + Math.round(s.retention * 100) + ' % · intervalle max ' + s.maxIvl + ' j');
  const inactive = new Set(s.inactive || []);
  const actifs = state.chapters.filter((c) => !inactive.has(c.id)).length;
  set('programme', actifs + ' chapitres actifs sur ' + state.chapters.length);
  set('apparence', themeLabel());
  const dots = $('sum-couleurs');
  if (dots) {
    dots.innerHTML = '';
    state.matieres.forEach((m) => {
      const d = document.createElement('i');
      d.className = 'sum-dot';
      d.style.background = PALETTE[matColorKey(m.id)];
      d.title = m.nom;
      dots.appendChild(d);
    });
  }
  set('notifs', notifSummary());
  const last = state.config.lastSync ? new Date(state.config.lastSync) : null;
  set('github', canSync() ? 'Synchronisé' + (last ? ' · ' + last.toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '') : 'Non configuré');
  const model = (MODELS.find(([v]) => v === (state.config.geminiModel || DEFAULT_MODEL)) || [, ''])[1].replace(/ \(.*\)$/, '');
  set('gemini', state.config.geminiKey ? 'Clé enregistrée · ' + model : 'Aucune clé sur cet appareil');
  set('sauvegarde', 'Exporter ou importer un fichier');
  set('anki', 'Importer ou exporter des paquets .apkg');
  set('edt', edtSummary());
}

function bindAccordion() {
  const view = $('view-parametres');
  view.querySelectorAll('details.acc').forEach((d) => {
    d.addEventListener('toggle', () => {
      if (!d.open) return;
      view.querySelectorAll('details.acc[open]').forEach((o) => { if (o !== d) o.open = false; });
      const top = d.getBoundingClientRect().top;
      if (top < 0 || top > innerHeight * 0.6) d.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
  });
  let pendingSum = false;
  const refresh = () => {
    if (pendingSum) return;
    pendingSum = true;
    requestAnimationFrame(() => { pendingSum = false; renderSummaries(); });
  };
  view.addEventListener('change', refresh);
  view.addEventListener('click', refresh);
  document.addEventListener('settings-summary', refresh);
}

// Choix de la couleur de chaque matière dans la palette.
function renderMatColors() {
  const box = $('matColors');
  box.innerHTML = '';
  state.matieres.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'mat-color-row';
    row.innerHTML = '<span class="ln"></span><div class="swatches wrap" role="radiogroup"></div>';
    row.querySelector('.ln').textContent = m.nom;
    row.querySelector('[role="radiogroup"]').setAttribute('aria-label', 'Couleur de ' + m.nom);
    const cur = matColorKey(m.id);
    Object.entries(PALETTE).forEach(([k, hex]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch' + (k === cur ? ' on' : '');
      b.style.setProperty('--sw', hex);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(k === cur));
      b.setAttribute('aria-label', k);
      b.title = k;
      b.addEventListener('click', () => {
        updateSettings({ matColors: { ...(state.progress.settings.matColors || {}), [m.id]: k } });
        renderMatColors();
      });
      row.querySelector('[role="radiogroup"]').appendChild(b);
    });
    box.appendChild(row);
  });
}

// Tableau des limites quotidiennes : une ligne par matière, nouvelles cartes et révisions maximum.
function renderSubjectLimits() {
  const box = $('subjectLimits');
  box.innerHTML = '<span></span><span class="lh">Nouvelles</span><span class="lh">Révisions</span><span class="lh">Du jour</span>';
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
    // Interrupteur : la matière est-elle mélangée aux autres dans la « Révision du jour » ?
    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.className = 'switch';
    sw.id = 'daily-' + m.id;
    sw.checked = !dailyOff().has(m.id);
    sw.setAttribute('aria-label', m.nom + ' dans la révision du jour');
    sw.addEventListener('change', () => {
      const off = dailyOff();
      if (sw.checked) off.delete(m.id); else off.add(m.id);
      updateSettings({ dailyOff: [...off] });
    });
    const cell = document.createElement('span');
    cell.className = 'lsw';
    cell.appendChild(sw);
    box.appendChild(cell);
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
  bindAccordion();
  bindAnki();
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
  const saveGemini = () => {
    state.config = { ...state.config, geminiKey: $('gemKey').value.trim(), geminiModel: $('gemModel').value };
    S.saveConfig(state.config);
    setStatus('gemStatus', state.config.geminiKey ? 'Clé enregistrée sur cet appareil.' : 'Clé supprimée de cet appareil.', 'ok');
  };
  $('gemKey').addEventListener('change', saveGemini);
  $('gemModel').addEventListener('change', saveGemini);
  $('gSave').addEventListener('click', saveGitHubConfig);
  $('gForget').addEventListener('click', forgetToken);
  $('exportBtn').addEventListener('click', exportProgress);
  $('importFile').addEventListener('change', (e) => importProgress(e.target));
}
