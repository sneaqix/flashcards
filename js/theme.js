// Chartes graphiques (css/themes.css) et mode clair / sombre, choisis sur chaque appareil.
// Le choix est appliqué avant l'affichage par un petit script dans <head> (index.html).
import { $ } from './ui.js?v=20261031214820';

const LS = 'fc.theme';
export const THEMES = [
  ['cahier', 'Cahier', 'Papier quadrillé, encre bleue'],
  ['tableau', 'Tableau', 'Ardoise et craie ; feutre en clair'],
  ['epure', 'Épuré', 'Style iOS ; noir pur en sombre'],
  ['biblio', 'Bibliothèque', 'Papier crème, typo à empattements'],
  ['brutal', 'Néo-brutal', 'Couleurs franches, contours noirs'],
  ['pastel', 'Pastel', 'Lavande, coins très ronds'],
  ['terminal', 'Terminal', 'Vert phosphore, monospace'],
];
const MODES = [['light', 'Clair'], ['dark', 'Sombre'], ['auto', 'Auto']];
const FONTS = {
  tableau: 'family=Kalam:wght@700',
  biblio: 'family=Fraunces:opsz,wght@9..144,600;9..144,800&family=Literata:opsz,wght@7..72,400;7..72,600',
  brutal: 'family=Space+Grotesk:wght@400;600;700',
  pastel: 'family=Nunito:wght@400;600;800',
  terminal: 'family=JetBrains+Mono:wght@400;500;700',
};
const fontUrl = (ids) => {
  const fam = ids.map((id) => FONTS[id]).filter(Boolean);
  return fam.length ? 'https://fonts.googleapis.com/css2?' + fam.join('&') + '&display=swap' : null;
};

function read() {
  try {
    const t = JSON.parse(localStorage.getItem(LS) || '{}');
    return { theme: THEMES.some(([id]) => id === t.theme) ? t.theme : 'cahier', mode: MODES.some(([m]) => m === t.mode) ? t.mode : 'auto' };
  } catch (e) { return { theme: 'cahier', mode: 'auto' }; }
}

function loadFonts(id, ids) {
  const url = fontUrl(ids);
  let link = document.getElementById(id);
  if (!url) { if (link) link.remove(); return; }
  if (link && link.href === url) return;
  if (!link) { link = document.createElement('link'); link.rel = 'stylesheet'; link.id = id; document.head.appendChild(link); }
  link.href = url;
}

// Couleur de la barre du navigateur, accordée au fond de la charte.
function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  requestAnimationFrame(() => {
    const c = getComputedStyle(document.body).getPropertyValue('--paper').trim();
    if (c) meta.content = c;
  });
}

// Libellé court du choix actuel, pour le résumé dans les Réglages.
export function themeLabel() {
  const t = read();
  const th = THEMES.find(([id]) => id === t.theme);
  return (th ? th[1] : 'Cahier') + ' · ' + MODES.find(([m]) => m === t.mode)[1];
}

export function applyTheme(t = read()) {
  const html = document.documentElement;
  html.dataset.theme = t.theme;
  html.dataset.mode = t.mode;
  loadFonts('themeFont', [t.theme]);
  syncThemeColor();
}

function save(t) {
  try { localStorage.setItem(LS, JSON.stringify(t)); } catch (e) { /* indisponible */ }
  applyTheme(t);
  renderAppearance();
  document.dispatchEvent(new Event('settings-summary'));
}

export function renderAppearance() {
  const box = $('themeList');
  if (!box) return;
  const t = read();
  loadFonts('themePreviewFonts', THEMES.map(([id]) => id)); // pour les aperçus
  if (!box.children.length) {
    THEMES.forEach(([id, name, desc]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'th-opt';
      b.dataset.id = id;
      b.innerHTML = '<span class="th-prev" data-theme="' + id + '"><span class="th-card"><b>Aa</b><i></i></span><span class="th-btn"></span></span>' +
        '<span class="th-name"></span><span class="th-desc"></span>';
      b.querySelector('.th-name').textContent = name;
      b.querySelector('.th-desc').textContent = desc;
      b.addEventListener('click', () => save({ ...read(), theme: id }));
      box.appendChild(b);
    });
    MODES.forEach(([m, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.mode = m;
      b.textContent = label;
      b.addEventListener('click', () => save({ ...read(), mode: m }));
      $('themeMode').appendChild(b);
    });
  }
  box.querySelectorAll('.th-opt').forEach((b) => {
    const on = b.dataset.id === t.theme;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.querySelector('.th-prev').dataset.mode = t.mode;
  });
  $('themeMode').querySelectorAll('button').forEach((b) => {
    const on = b.dataset.mode === t.mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

export function bindTheme() {
  applyTheme();
  // En mode Auto, la couleur de la barre suit le passage clair / sombre du système.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeColor);
}
