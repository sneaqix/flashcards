// Page « Camarades » (compte administrateur) : activité de révision de chaque compte.
// Les données viennent de la fonction admin_stats de la base (journaux de progression seulement).
import * as S from './store.js?v=20261112135907';
import { $, state, escapeHtml, plural } from './ui.js?v=20261112135907';
import { lastDays, shortDate, fmtMin, barChart } from './stats.js?v=20261112135907';

let rows = null;

const totals = (logs, day) => S.dayTotals({ logs }, day);
function streakOf(logs) {
  const t = S.today();
  let i = totals(logs, t).r > 0 ? 0 : 1;
  let n = 0;
  while (totals(logs, S.addDays(t, -i)).r > 0 && n < 400) { n++; i++; }
  return n;
}
function lastReview(logs) {
  let last = '';
  Object.values(logs || {}).forEach((days) => Object.entries(days || {}).forEach(([d, l]) => { if (l && l.r > 0 && d > last) last = d; }));
  return last;
}
function ago(day) {
  if (!day) return 'jamais';
  const n = Math.round((new Date(S.today()) - new Date(day)) / 86400000);
  return n === 0 ? 'aujourd\'hui' : n === 1 ? 'hier' : 'il y a ' + n + ' jours';
}

function summarize(r) {
  const logs = r.logs || {};
  const week = lastDays(7).map((d) => totals(logs, d));
  return {
    name: r.username, me: r.me, logs,
    today: totals(logs, S.today()).r,
    week: week.reduce((a, t) => a + t.r, 0),
    weekTime: week.reduce((a, t) => a + (t.t || 0), 0),
    streak: streakOf(logs),
    last: lastReview(logs),
  };
}

function render() {
  const box = $('classeBody');
  if (!rows) { box.innerHTML = '<p class="sub">Chargement…</p>'; return; }
  const list = rows.map(summarize).sort((a, b) => b.week - a.week || b.today - a.today || a.name.localeCompare(b.name));
  let html = '<section class="panel"><h2>Cette semaine</h2><div class="classe-table" role="table" aria-label="Comparaison des comptes">' +
    '<div class="ct-row ct-head" role="row"><span role="columnheader">Compte</span><span role="columnheader">Aujourd\'hui</span><span role="columnheader">7 jours</span><span role="columnheader">Temps</span><span role="columnheader">Série</span><span role="columnheader">Dernière révision</span></div>' +
    list.map((u) => '<div class="ct-row' + (u.me ? ' me' : '') + '" role="row">' +
      '<span role="cell"><b>' + escapeHtml(u.name) + '</b>' + (u.me ? ' <small>(toi)</small>' : '') + '</span>' +
      '<span role="cell" data-l="Aujourd\'hui">' + u.today + '</span>' +
      '<span role="cell" data-l="7 jours">' + u.week + '</span>' +
      '<span role="cell" data-l="Temps">' + (u.weekTime ? fmtMin(u.weekTime) : '–') + '</span>' +
      '<span role="cell" data-l="Série">' + (u.streak ? plural(u.streak, 'jour', 'jours') : '–') + '</span>' +
      '<span role="cell" data-l="Dernière">' + ago(u.last) + '</span></div>').join('') +
    '</div></section>';
  const days = lastDays(30);
  html += list.map((u) => {
    const vals = days.map((d) => totals(u.logs, d));
    const sum = vals.reduce((a, t) => a + t.r, 0);
    return '<section class="panel classe-user"><header><h2>' + escapeHtml(u.name) + (u.me ? ' <small>(toi)</small>' : '') + '</h2>' +
      '<span class="sub">' + plural(sum, 'carte', 'cartes') + ' en 30 jours</span></header>' +
      '<div class="chart">' + barChart({
        series: [{ values: vals.map((t) => t.r), cls: 'c-acc' }],
        labels: (i) => (i % 7 === 2 ? shortDate(days[i]) : null),
        height: 130,
        title: 'Cartes révisées par jour, 30 derniers jours : ' + u.name,
        tip: (i) => shortDate(days[i]) + ' : ' + plural(vals[i].r, 'carte', 'cartes') + (vals[i].t ? ' · ' + fmtMin(vals[i].t) : ''),
      }) + '</div></section>';
  }).join('');
  box.innerHTML = html;
}

async function load() {
  try {
    rows = await state.gh.rpc('admin_stats');
    $('classeState').textContent = 'Mis à jour à ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + ' · ' + plural(rows.length, 'compte', 'comptes') + '.';
    $('classeState').className = 'edt-state';
  } catch (e) {
    $('classeState').textContent = 'Lecture impossible : ' + e.message + (/admin_stats|non autorisé|404/i.test(e.message) ? ' (le script tools/supabase-classe.sql a-t-il été lancé ?)' : '');
    $('classeState').className = 'edt-state warn';
  }
}

export async function renderClasse() {
  render();
  if (!state.gh || state.gh.kind !== 'supabase') return;
  await load();
  render();
}

export function bindClasse() {
  if (!$('view-classe')) return;
  $('classeRefresh').addEventListener('click', async () => { await load(); render(); });
}
