// État partagé de l'appli et petits outils d'affichage.
import * as S from './store.js?v=20261030232723';

export const $ = (id) => document.getElementById(id);
export const TABS = ['reviser', 'bachotage', 'cartes', 'classeur', 'calendrier', 'stats', 'parametres'];

export const state = {
  matieres: [],          // [{ id, nom, chapitres: [chapter] }]
  chapters: [],          // tous les chapitres
  byId: new Map(),
  progress: S.loadProgress(),
  config: S.loadConfig(),
  gh: null,
  session: null,         // révision en cours
  finished: null,        // dernière session terminée (pour annuler sa dernière réponse)
  lastMode: 'srs',
  syncing: false,
  syncAgain: false,
  imgCache: new Map(),   // images ajoutées pendant cette visite (avant mise à jour du site)
  edit: null,            // carte ouverte dans l'éditeur
  editReturn: null,      // 'session' quand l'éditeur a été ouvert pendant une révision
  cramSel: new Set(),
  discardUntil: 0,       // délai pendant lequel on peut abandonner des modifications non enregistrées
  views: {},             // fonctions d'affichage de chaque onglet (renseignées par app.js)
};

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export function typeset(...els) {
  els = els.filter(Boolean);
  if (!els.length || !window.MathJax || !MathJax.typesetPromise) return;
  if (MathJax.typesetClear) MathJax.typesetClear(els);
  MathJax.typesetPromise(els).catch(() => {});
}
export function imageUrl(path) {
  return state.imgCache.get(path) || path;
}
export function textHtml(text) {
  return escapeHtml(text || '').replace(/\n/g, '<br>');
}
export function renderFace(el, text, img) {
  el.innerHTML = textHtml(text);
  if (img) {
    const im = new Image();
    im.alt = '';
    im.src = imageUrl(img);
    el.appendChild(im);
  }
  typeset(el);
}
let toastTimer;
export function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}
export function setStatus(id, msg, kind = '') {
  const el = $(id);
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
}
export function plural(n, one, many) { return n + ' ' + (n > 1 ? many : one); }
export function saveProgress() { S.saveProgress(state.progress); }
// Matières exclues de la « Révision du jour » (toujours révisables avec leur propre bouton).
// Par défaut, le français-philo n'est pas mélangé aux autres matières.
export function dailyOff() {
  const v = state.progress.settings.dailyOff;
  return new Set(Array.isArray(v) ? v : ['francais']);
}
export function dailyChapters() {
  const off = dailyOff();
  return activeChapters().filter((c) => !off.has(c.matiere));
}
export function activeChapters() {
  const off = new Set(state.progress.settings.inactive || []);
  return state.chapters.filter((c) => !off.has(c.id));
}
export function canSync() { return !!(state.gh && state.config.dataRepo); }
export function canEdit() { return !!(state.gh && state.config.contentRepo); }
export function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// Texte à trous : « Venice suffers from {{overtourism::surtourisme}}. »
// Renvoie les morceaux [{ text }] et [{ answer, hint }] dans l'ordre.
export function clozeParts(text) {
  const parts = [];
  const re = /\{\{(.+?)\}\}/g;
  let last = 0, m;
  while ((m = re.exec(text || ''))) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    const [answer, hint] = m[1].split('::');
    parts.push({ answer: answer.trim(), hint: (hint || '').trim() });
    last = re.lastIndex;
  }
  if (last < (text || '').length) parts.push({ text: text.slice(last) });
  return parts;
}
export function isCloze(card) { return card.mode === 'trou'; }
function clozeText(text, filled) {
  return clozeParts(text).map((p) => (p.answer === undefined ? p.text : filled ? '« ' + p.answer.split('/')[0].trim() + ' »' : '[…' + (p.hint ? ' ' + p.hint + ' ' : '') + ']')).join('');
}

// Contenu affiché d'une face : une face inversée échange question et réponse.
export function faceContent(item) {
  const c = item.card;
  if (isCloze(c)) {
    return { q: clozeText(c.q, false), r: clozeText(c.q, true) + (c.r ? '\n\n' + c.r : ''), img_q: c.img_q, img_r: c.img_r };
  }
  return item.rev
    ? { q: c.r, r: c.q, img_q: c.img_r, img_r: c.img_q }
    : { q: c.q, r: c.r, img_q: c.img_q, img_r: c.img_r };
}
export function firstLine(text) {
  return String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
}
// Réponse courte attendue (saisie, choix multiples, associations).
export function expectedAnswer(card) {
  if (isCloze(card)) return clozeParts(card.q).filter((p) => p.answer !== undefined).map((p) => p.answer.split('/')[0].trim()).join(' · ');
  return (card.attendu && card.attendu.trim()) || firstLine(card.r);
}

// Répartition des faces d'un chapitre dans les paliers N, j1, j2…
export function chapterCounts(ch) {
  const counts = new Array(S.BUCKETS.length).fill(0);
  S.faces(ch).forEach((f) => { counts[S.bucketOf(S.stateOf(state.progress, f.key))]++; });
  return counts;
}

// ---------- Navigation ----------
export function showView(name) {
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + name; });
  const fromViewer = state.editReturn === 'classeur';
  const tab = name === 'carte' ? (state.editReturn === 'session' ? null : fromViewer ? 'classeur' : 'cartes')
    : name === 'assoc' ? 'bachotage' : name === 'import' ? 'cartes' : name === 'lecteur' || name === 'docform' || name === 'carnet' || name === 'entree' ? 'classeur' : name === 'tache' ? 'calendrier' : name === 'stats' ? (matchMedia('(min-width: 900px)').matches ? 'stats' : 'parametres') : name;
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  // Téléphone : « Plus » regroupe Cartes, Statistiques et Réglages ; l'en-tête affiche le nom de l'onglet.
  const more = document.getElementById('tabMore');
  if (more) more.classList.toggle('active', ['cartes', 'stats', 'parametres'].includes(name === 'stats' ? 'stats' : tab));
  const label = { reviser: 'Réviser', bachotage: 'Bachotage', cartes: 'Cartes', classeur: 'Classeur', calendrier: 'Calendrier', stats: 'Statistiques', parametres: 'Réglages' }[name === 'stats' ? 'stats' : tab];
  const hTab = document.getElementById('hTab');
  if (hTab && label) hTab.textContent = label;
  document.body.classList.toggle('reviewing', name === 'session');
  document.body.classList.toggle('in-session', ['session', 'done', 'assoc', 'lecteur', 'carnet', 'entree'].includes(name) || (name === 'carte' && (state.editReturn === 'session' || fromViewer)));
  document.body.classList.toggle('reading', name === 'lecteur');
  document.body.classList.toggle('cal', name === 'calendrier');
  document.body.classList.toggle('carnet-open', name === 'carnet');
  document.body.classList.toggle('entree-open', name === 'entree');
  window.scrollTo(0, 0);
}
export function currentTab() {
  const h = location.hash.slice(1);
  return TABS.includes(h) ? h : 'reviser';
}
export function route() {
  if (state.session || state.assoc) return;
  const tab = currentTab();
  showView(tab); // l'onglet doit être visible avant d'y mettre en forme des formules
  state.views[tab]();
  document.dispatchEvent(new Event('nav-refresh')); // compteurs de la barre latérale
}
export function goTab(tab) {
  if (location.hash.slice(1) !== tab) location.hash = tab;
  else route();
}
// Rafraîchit la vue affichée après une synchronisation, sauf si l'utilisateur est en train de réviser ou d'écrire.
export function refreshIfIdle() {
  if (state.session || state.assoc || ['carte', 'done', 'import', 'lecteur', 'docform', 'tache', 'carnet', 'entree'].some((v) => !$('view-' + v).hidden)) return;
  if (document.activeElement && document.activeElement.matches('input, textarea, select')) return;
  route();
}
