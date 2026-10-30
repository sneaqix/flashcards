// Point d'entrée : chargement, navigation entre les onglets et synchronisation automatique.
import { GitHub } from './github.js?v=20261030124834';
import { $, state, route, typeset, canSync } from './ui.js?v=20261030124834';
import { setChip, syncNow, scheduleSync, flushSync, loadDecks } from './sync.js?v=20261030124834';
import { renderHome, bindReview } from './review.js?v=20261030124834';
import { renderCartes, bindEditor } from './editor.js?v=20261030124834';
import { renderCram, bindPractice } from './practice.js?v=20261030124834';
import { bindImport, restoreImport } from './importer.js?v=20261030124834';
import { renderClasseur, bindClasseur, loadClasseur } from './classeur.js?v=20261030124834';
import { bindViewer } from './viewer.js?v=20261030124834';
import { bindCarnets } from './carnets.js?v=20261030124834';
import { renderAgenda, bindAgenda, loadAgenda } from './agenda.js?v=20261030124834';
import { renderStats } from './stats.js?v=20261030124834';
import { renderSettings, bindSettings } from './settings.js?v=20261030124834';

state.views = {
  reviser: renderHome,
  bachotage: renderCram,
  cartes: renderCartes,
  classeur: renderClasseur,
  calendrier: renderAgenda,
  stats: renderStats,
  parametres: renderSettings,
};

function bindEvents() {
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

  // Sauvegarde quand on quitte l'appli, récupération des changements de l'autre appareil au retour.
  document.addEventListener('visibilitychange', () => {
    if (!canSync()) return;
    if (document.visibilityState === 'hidden') flushSync();
    else if (Date.now() - (state.config.lastSync || 0) > 60000) scheduleSync(0);
  });
}

async function init() {
  bindEvents();
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
  agendaReady.then(() => { if (!state.session && (!$('view-calendrier').hidden || currentTabIsHome())) route(); });
  // Le classeur est chargé en arrière-plan pour afficher les documents de chaque chapitre.
  if (canSync()) loadClasseur().then(() => { if (!state.session && currentTabIsHome()) route(); }).catch(() => {});
}

function currentTabIsHome() {
  return !$('view-reviser').hidden;
}

init();
