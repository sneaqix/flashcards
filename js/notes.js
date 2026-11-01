// Page Notes : notes de Mon Bureau Numérique lues par l'API de Skolengo (workflow edt.yml du dépôt privé)
// (edt/notes.json et edt/notes-history.json).
import { $, state, escapeHtml, toast, canSync } from './ui.js?v=20261101194810';
import { matColor } from './agenda.js?v=20261101194810';

const LS = 'fc.notes';
let data = readLocal();
let period = null;

function readLocal() { try { return JSON.parse(localStorage.getItem(LS)) || null; } catch (e) { return null; } }
function saveLocal() { try { localStorage.setItem(LS, JSON.stringify(data)); } catch (e) { /* plein */ } }
const fmt = (n) => (n === null || n === undefined ? '–' : String(Math.round(n * 100) / 100).replace('.', ','));

async function load() {
  if (!canSync()) return;
  try {
    const [n, h] = await Promise.all([
      state.gh.getFile(state.config.dataRepo, 'edt/notes.json'),
      state.gh.getFile(state.config.dataRepo, 'edt/notes-history.json').catch(() => null),
    ]);
    data = { notes: n ? JSON.parse(n.text) : null, history: h ? JSON.parse(h.text) : { points: [] } };
    saveLocal();
  } catch (e) { console.warn('Notes non lues', e); }
}

export async function renderNotes() {
  render();
  await load();
  if (!$('view-notes').hidden) render();
}

function chart(points) {
  if (points.length < 2) return '<p class="sub">Le graphique apparaîtra après quelques jours de relevés.</p>';
  const W = Math.max(300, Math.min(900, ($('notesBody').clientWidth || 600) - 40)), H = 170, P = 28;
  const vals = points.flatMap((p) => [p.general, p.classGeneral]).filter((v) => typeof v === 'number');
  const lo = Math.max(0, Math.floor(Math.min(...vals) - 1)), hi = Math.min(20, Math.ceil(Math.max(...vals) + 1));
  const x = (i) => P + (i * (W - 2 * P)) / (points.length - 1);
  const y = (v) => H - P - ((v - lo) * (H - 2 * P)) / Math.max(1, hi - lo);
  const line = (k) => points.map((p, i) => (typeof p[k] === 'number' ? (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p[k]).toFixed(1) : '')).join(' ');
  const d0 = points[0].date.slice(8, 10) + '/' + points[0].date.slice(5, 7), d1 = points[points.length - 1].date.slice(8, 10) + '/' + points[points.length - 1].date.slice(5, 7);
  return '<svg class="notes-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Évolution de la moyenne générale">' +
    [lo, (lo + hi) / 2, hi].map((v) => '<line x1="' + P + '" x2="' + (W - P) + '" y1="' + y(v) + '" y2="' + y(v) + '" class="nc-grid"/><text x="4" y="' + (y(v) + 4) + '" class="nc-lbl">' + fmt(v) + '</text>').join('') +
    '<path d="' + line('classGeneral') + '" class="nc-class"/><path d="' + line('general') + '" class="nc-me"/>' +
    points.map((p, i) => '<circle cx="' + x(i) + '" cy="' + y(p.general) + '" r="3" class="nc-dot"><title>' + p.date + ' : ' + fmt(p.general) + '</title></circle>').join('') +
    '<text x="' + P + '" y="' + (H - 6) + '" class="nc-lbl">' + d0 + '</text><text x="' + (W - P) + '" y="' + (H - 6) + '" text-anchor="end" class="nc-lbl">' + d1 + '</text></svg>' +
    '<p class="notes-legend"><i class="me"></i> Toi <i class="cl"></i> Classe</p>';
}

function render() {
  const box = $('notesBody');
  const n = data && data.notes;
  const periods = (n && n.periods) || [];
  const st = $('notesState');
  if (!n || (!periods.length && !n.error)) {
    st.innerHTML = 'Pas encore de notes. Elles sont lues avec ton jeton Skolengo (le même que l\'emploi du temps), deux fois par jour.';
    st.className = 'edt-state warn';
  } else {
    const when = n.updated ? new Date(n.updated).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    st.textContent = (n.error ? n.error + (when ? ' Dernier relevé réussi : ' + when + '.' : '') : 'Relevé du ' + when + '.');
    st.className = 'edt-state' + (n.error ? ' warn' : '');
  }
  if (!periods.length) { box.innerHTML = ''; $('notesPeriods').innerHTML = ''; return; }
  if (!periods.some((p) => p.id === period)) period = (periods.find((p) => p.current && p.subjects.length) || periods.find((p) => p.subjects.length) || periods[0]).id;
  const chips = $('notesPeriods');
  chips.innerHTML = '';
  periods.forEach((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = p.label;
    b.className = p.id === period ? 'on' : '';
    b.setAttribute('aria-pressed', String(p.id === period));
    b.addEventListener('click', () => { period = p.id; render(); });
    chips.appendChild(b);
  });
  const p = periods.find((x) => x.id === period);
  const pts = ((data.history && data.history.points) || []).filter((x) => x.period === p.label);
  if (!p.subjects.some((x) => (x.evaluations || []).length || typeof x.average === 'number')) { box.innerHTML = '<p class="sub">Aucune note pour cette période.</p>'; return; }
  let html = '<section class="panel notes-general"><div><span class="sub">Moyenne générale</span><b>' + fmt(p.general) + '</b></div>' +
    '<div><span class="sub">Classe</span><b class="cl">' + fmt(p.classGeneral) + '</b></div></section>';
  html += '<section class="panel"><h2>Évolution</h2>' + chart(pts) + '</section>';
  if (!p.subjects.length) html += '<p class="sub">Aucune note pour cette période.</p>';
  html += '<div class="notes-list">' + p.subjects.map((s, si) => {
    if (!(s.evaluations || []).length && typeof s.average !== 'number') return ''; // matière sans note : masquée
    const c = s.mat ? matColor(s.mat) : 'var(--muted)';
    const marks = (s.evaluations || []).map((e, ei) => {
      const has = e.mark !== null && e.mark !== undefined;
      const off = e.counted === false;
      const tone = has && e.scale && !off ? (e.mark / e.scale >= 0.7 ? ' good' : e.mark / e.scale < 0.45 ? ' low' : '') : '';
      const label = has ? fmt(e.mark) : (e.raw || '');
      return '<button type="button" class="nt' + (has ? tone : ' empty') + (off ? ' off' : '') + '" data-ev="' + si + ':' + ei + '"' +
        ' aria-label="' + escapeHtml(label + (has ? ' sur ' + fmt(e.scale) : '') + (off ? ', ne compte pas dans la moyenne' : '') + ' : voir le détail') + '">' +
        '<b>' + escapeHtml(label || '·') + '</b>' + (has ? '<small>/' + fmt(e.scale) + '</small>' : '') + '</button>';
    }).join('');
    return '<article class="panel notes-subject" style="--c:' + escapeHtml(c) + '"><header><div><h3>' + escapeHtml(s.label) + '</h3>' +
      (s.teacher ? '<span class="sub">' + escapeHtml(s.teacher) + '</span>' : '') + '</div><b class="ns-avg">' + fmt(s.average) + '</b></header>' +
      (s.classAverage !== null && s.classAverage !== undefined ? '<p class="ns-class">Classe ' + fmt(s.classAverage) + (s.min !== null && s.min !== undefined ? ' · min ' + fmt(s.min) + ' · max ' + fmt(s.max) : '') + '</p>' : '') +
      (marks ? '<div class="ns-marks">' + marks + '</div>' : '') + '</article>';
  }).join('') + '</div>';
  box.innerHTML = html;
}

// ---------- Détail d'une note ----------
function openDetail(btn) {
  const p = data.notes.periods.find((x) => x.id === period);
  const [si, ei] = btn.dataset.ev.split(':').map(Number);
  const s = p.subjects[si], e = s.evaluations[ei];
  const has = e.mark !== null && e.mark !== undefined;
  const d = e.date ? new Date(e.date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' }) : '';
  const row = (k, v) => (v === null || v === undefined ? '' : '<div><dt>' + k + '</dt><dd>' + fmt(v) + '</dd></div>');
  const cls = row('Moyenne', e.classAverage) + row('Min.', e.min) + row('Max.', e.max);
  $('noteDlgBody').innerHTML =
    '<p class="nd-mat" style="--c:' + escapeHtml(s.mat ? matColor(s.mat) : 'var(--muted)') + '">' + escapeHtml(s.label) + '</p>' +
    '<h2>' + escapeHtml(e.topic || e.title || 'Évaluation') + '</h2>' +
    (d ? '<p class="nd-date">' + escapeHtml(d) + '</p>' : '') +
    '<h3>Élève</h3><p class="nd-mark' + (e.counted === false ? ' off' : '') + '">' + (has ? '<b>' + fmt(e.mark) + '</b> / ' + fmt(e.scale) : '<b>' + escapeHtml(e.raw || 'Non évalué') + '</b>') +
    (e.coef !== null && e.coef !== undefined ? ' <span class="sub">(coef. ' + fmt(e.coef) + ')</span>' : '') + '</p>' +
    (e.counted === false ? '<p class="nd-off">Cette note ne compte pas dans la moyenne.</p>' : '') +
    (e.comment ? '<p class="nd-comment">' + escapeHtml(e.comment) + '</p>' : '') +
    (cls ? '<h3>Classe</h3><dl class="nd-class">' + cls + '</dl>' : '');
  $('noteDlg').showModal();
}

// Actualiser : dépose edt/notes-refresh, ce qui relance le workflow de l'emploi du temps et des notes.
async function refresh() {
  if (!canSync()) { toast('Configure d\'abord la synchronisation GitHub.'); return; }
  $('notesRefresh').disabled = true;
  try {
    let sha = null;
    try { const f = await state.gh.getFile(state.config.dataRepo, 'edt/notes-refresh'); sha = f && f.sha; } catch (e) { /* nouveau */ }
    await state.gh.putFile(state.config.dataRepo, 'edt/notes-refresh', String(Date.now()) + '\n', sha, 'Notes : actualisation demandée');
    toast('Nouvel essai demandé : réponse dans 1 à 2 minutes.');
    setTimeout(async () => { await load(); if (!$('view-notes').hidden) render(); }, 120000);
  } catch (e) {
    toast('Impossible de demander le relevé : ' + e.message);
  } finally {
    $('notesRefresh').disabled = false;
  }
}

export function bindNotes() {
  if (!$('view-notes')) return;
  $('notesRefresh').addEventListener('click', refresh);
  // Toucher une note ouvre son détail.
  $('notesBody').addEventListener('click', (e) => {
    const t = e.target.closest('.nt[data-ev]');
    if (t) openDetail(t);
  });
  const dlg = $('noteDlg');
  dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); });
}
