// Point d'entrée : chargement, navigation entre les onglets et synchronisation automatique.
import { GitHub } from './github.js?v=20261030100814';
import { $, state, route, typeset, canSync } from './ui.js?v=20261030100814';
import { setChip, syncNow, scheduleSync, flushSync, loadDecks } from './sync.js?v=20261030100814';
import { renderHome, bindReview } from './review.js?v=20261030100814';
import { renderCartes, bindEditor } from './editor.js?v=20261030100814';
import { renderCram, bindPractice } from './practice.js?v=20261030100814';
import { bindImport, restoreImport } from './importer.js?v=20261030100814';
import { renderClasseur, bindClasseur, loadClasseur } from './classeur.js?v=20261030100814';
import { bindViewer } from './viewer.js?v=20261030100814';
import { renderStats } from './stats.js?v=20261030100814';
import { renderSettings, bindSettings } from './settings.js?v=20261030100814';

state.views = {
  reviser: renderHome,
  bachotage: renderCram,
  cartes: renderCartes,
  classeur: renderClasseur,
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
  route();
  restoreImport(); // relecture ou génération laissée en plan
  if (canSync()) syncNow();
  // Le classeur est chargé en arrière-plan pour afficher les documents de chaque chapitre.
  if (canSync()) loadClasseur().then(() => { if (!state.session && currentTabIsHome()) route(); }).catch(() => {});
}

function currentTabIsHome() {
  return !$('view-reviser').hidden;
}

init();
