// Point d'entrée : chargement, navigation entre les onglets et synchronisation automatique.
import * as S from './store.js?v=20261031181747';
import { GitHub } from './github.js?v=20261031181747';
import { $, state, route, typeset, canSync, dailyChapters } from './ui.js?v=20261031181747';
import { setChip, syncNow, scheduleSync, flushSync, loadDecks } from './sync.js?v=20261031181747';
import { renderHome, bindReview, startDailyReview, dailyToday } from './review.js?v=20261031181747';
import { renderCartes, bindEditor } from './editor.js?v=20261031181747';
import { renderCram, bindPractice } from './practice.js?v=20261031181747';
import { bindImport, restoreImport } from './importer.js?v=20261031181747';
import { renderClasseur, bindClasseur, loadClasseur } from './classeur.js?v=20261031181747';
import { bindViewer } from './viewer.js?v=20261031181747';
import { bindCarnets } from './carnets.js?v=20261031181747';
import { renderAgenda, bindAgenda, loadAgenda, dueNow, renderTodayPanel } from './agenda.js?v=20261031181747';
import { renderStats } from './stats.js?v=20261031181747';
import { renderSettings, bindSettings } from './settings.js?v=20261031181747';
import { bindEdt } from './edt.js?v=20261031181747';
import { bindTheme } from './theme.js?v=20261031181747';
import { registerWorker, bindNotifs, checkSubscription } from './notifs.js?v=20261031181747';

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
  setCount('cnt-reviser', dailyToday().items.length);
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

// ---------- Téléphone : menu « Plus » et « tirer pour synchroniser » ----------
function bindPhone() {
  const sheet = $('moreSheet');
  const close = () => { sheet.classList.remove('open'); setTimeout(() => { if (!sheet.classList.contains('open')) sheet.hidden = true; }, 220); };
  $('tabMore').addEventListener('click', () => {
    sheet.hidden = false;
    requestAnimationFrame(() => sheet.classList.add('open'));
    const first = sheet.querySelector('a');
    if (first) first.focus({ preventScroll: true });
  });
  sheet.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', close));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) close(); });

  // Tirer l'accueil vers le bas lance la synchronisation.
  const ptr = $('ptr');
  let y0 = null, dy = 0;
  const phone = matchMedia('(max-width: 899px)');
  const active = () => phone.matches && canSync() && !state.session && !$('view-reviser').hidden && window.scrollY <= 0;
  window.addEventListener('touchstart', (e) => { y0 = active() && e.touches.length === 1 ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    const d = Math.min(dy, 110);
    ptr.style.setProperty('--d', d + 'px');
    ptr.classList.toggle('show', d > 8);
    ptr.classList.toggle('ready', dy > 75);
  }, { passive: true });
  window.addEventListener('touchend', () => {
    if (y0 === null) return;
    const go = dy > 75;
    y0 = null;
    ptr.classList.remove('ready');
    if (go) {
      ptr.classList.add('busy');
      syncNow().finally(() => { ptr.classList.remove('busy', 'show'); ptr.style.removeProperty('--d'); });
    } else {
      ptr.classList.remove('show');
      ptr.style.removeProperty('--d');
    }
  });
}

// Ordinateur : isole le symbole en tête des boutons (‹ › ✎ ↶ + …) pour l'animer au survol.
const GLYPH = /^(\s*)([‹›←→✎↶+⚑×✕]|i(?=$))(\s*)/;
function wrapGlyphs(root = document) {
  root.querySelectorAll('button:not([data-gly])').forEach((b) => {
    b.dataset.gly = '1';
    const t = b.firstChild;
    if (!t || t.nodeType !== 3) return;
    const m = t.nodeValue.match(GLYPH);
    if (!m) return;
    const span = document.createElement('span');
    span.className = 'gly';
    span.dataset.g = m[2];
    span.setAttribute('aria-hidden', 'true');
    span.textContent = m[2];
    t.nodeValue = t.nodeValue.slice(m[0].length);
    b.insertBefore(span, t);
    if (t.nodeValue) b.insertBefore(document.createTextNode(m[3] || ' '), t);
  });
}
function bindGlyphs() {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  wrapGlyphs();
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; wrapGlyphs(); });
  }).observe(document.body, { childList: true, subtree: true });
}

function bindEvents() {
  bindSidebar();
  bindGlyphs();
  bindPhone();
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
  bindEdt();

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
