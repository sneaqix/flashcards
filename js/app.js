// Point d'entrée : chargement, navigation entre les onglets et synchronisation automatique.
import * as S from './store.js?v=20261030210746';
import { GitHub } from './github.js?v=20261030210746';
import { $, state, route, typeset, canSync, dailyChapters } from './ui.js?v=20261030210746';
import { setChip, syncNow, scheduleSync, flushSync, loadDecks } from './sync.js?v=20261030210746';
import { renderHome, bindReview, startDailyReview } from './review.js?v=20261030210746';
import { renderCartes, bindEditor } from './editor.js?v=20261030210746';
import { renderCram, bindPractice } from './practice.js?v=20261030210746';
import { bindImport, restoreImport } from './importer.js?v=20261030210746';
import { renderClasseur, bindClasseur, loadClasseur } from './classeur.js?v=20261030210746';
import { bindViewer } from './viewer.js?v=20261030210746';
import { bindCarnets } from './carnets.js?v=20261030210746';
import { renderAgenda, bindAgenda, loadAgenda, dueNow, renderTodayPanel } from './agenda.js?v=20261030210746';
import { renderStats } from './stats.js?v=20261030210746';
import { renderSettings, bindSettings } from './settings.js?v=20261030210746';
import { bindTheme } from './theme.js?v=20261030210746';
import { registerWorker, bindNotifs, checkSubscription } from './notifs.js?v=20261030210746';

state.views = {
  reviser: renderHome,
  bachotage: renderCram,
  cartes: renderCartes,
  classeur: renderClasseur,
  calendrier: renderAgenda,
  stats: renderStats,
  parametres: renderSettings,
};

// ---------- Ordinateur : barre latérale ----------
const wide = matchMedia('(min-width: 900px)');
const wider = matchMedia('(min-width: 1280px)');
function setMini(on) {
  document.documentElement.classList.toggle('side-mini', on);
  $('sideToggle').setAttribute('aria-expanded', String(!on));
  $('sideToggle').setAttribute('aria-label', on ? 'Déplier le menu' : 'Réduire le menu');
}
function refreshNav() {
  if (!wide.matches || !state.chapters) return;
  const setCount = (id, n) => { const el = $(id); el.textContent = n; el.hidden = !n; };
  setCount('cnt-reviser', S.dailyQueue(state.progress, dailyChapters()).items.length);
  setCount('cnt-calendrier', dueNow().length);
  if (wider.matches && !state.session) renderTodayPanel($('todayPanel'));
}
function bindSidebar() {
  let mini = false;
  try { mini = localStorage.getItem('fc.sideMini') === '1'; } catch (e) { /* indisponible */ }
  setMini(mini);
  $('sideToggle').addEventListener('click', () => {
    const on = !document.documentElement.classList.contains('side-mini');
    setMini(on);
    try { localStorage.setItem('fc.sideMini', on ? '1' : '0'); } catch (e) { /* indisponible */ }
  });
  $('sideDaily').addEventListener('click', startDailyReview);
  document.addEventListener('nav-refresh', refreshNav);
  wide.addEventListener('change', refreshNav);
  wider.addEventListener('change', refreshNav);
}

function bindEvents() {
  bindSidebar();
  window.addEventListener('hashchange', route);
  document.addEventListener('mathjax-ready', () => {
    document.querySelectorAll('.view:not([hidden])').forEach((v) => typeset(v));
  });
  $('syncChip').addEventListener('click', () => {
    if (canSync()) syncNow();
    else if (!state.session) location.hash = 'parametres';
  });
  bindReview();
  bindEditor();
  bindPractice();
  bindSettings();
  bindImport();
  bindClasseur();
  bindViewer();
  bindAgenda();
  bindCarnets();
  bindNotifs();

  // Sauvegarde quand on quitte l'appli, récupération des changements de l'autre appareil au retour.
  document.addEventListener('visibilitychange', () => {
    if (!canSync()) return;
    if (document.visibilityState === 'hidden') flushSync();
    else if (Date.now() - (state.config.lastSync || 0) > 60000) scheduleSync(0);
  });
}

async function init() {
  bindTheme();
  bindEvents();
  registerWorker();
  if (state.config.token) state.gh = new GitHub(state.config.token);
  setChip(canSync() ? 'busy' : 'local');
  try {
    await loadDecks();
  } catch (e) {
    $('chapterList').innerHTML = '<p class="status error">Impossible de charger les cartes. Vérifie le dossier « decks » et le fichier index.json.</p>';
  }
  // Copie locale du calendrier lue tout de suite ; la version synchronisée arrive ensuite.
  const agendaReady = loadAgenda();
  route();
  restoreImport(); // relecture ou génération laissée en plan
  if (canSync()) syncNow();
  setTimeout(checkSubscription, 5000);
  agendaReady.then(() => { if (!state.session && (!$('view-calendrier').hidden || currentTabIsHome())) route(); });
  // Le classeur est chargé en arrière-plan pour afficher les documents de chaque chapitre.
  if (canSync()) loadClasseur().then(() => { if (!state.session && currentTabIsHome()) route(); }).catch(() => {});
}

function currentTabIsHome() {
  return !$('view-reviser').hidden;
}

init();
