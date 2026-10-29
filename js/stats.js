// Onglet Statistiques.
import * as S from './store.js?v=20261029224717';
import { $, state, escapeHtml, plural, activeChapters, typeset, faceContent } from './ui.js?v=20261029224717';
import { openFromElsewhere } from './editor.js?v=20261029224717';

const W = 360; // largeur logique des graphiques (ils s'adaptent à l'écran)

function lastDays(n) {
  const t = S.today();
  const days = [];
  for (let i = n - 1; i >= 0; i--) days.push(S.addDays(t, -i));
  return days;
}
function shortDate(isoDay) {
  const [, m, d] = isoDay.split('-');
  return d + '/' + m;
}
function fmtMin(ms) {
  const min = Math.round(ms / 60000);
  return min >= 60 ? Math.floor(min / 60) + ' h ' + String(min % 60).padStart(2, '0') : min + ' min';
}
function pct(a, b) { return b ? Math.round(a / b * 100) + ' %' : '–'; }

function streak(p) {
  const t = S.today();
  let i = S.dayTotals(p, t).r > 0 ? 0 : 1;
  let n = 0;
  while (S.dayTotals(p, S.addDays(t, -i)).r > 0) { n++; i++; }
  return n;
}

// Graphique en barres verticales. series : [{ values, cls }] empilées ; labels(i) : texte sous la barre ou null.
function barChart({ series, labels, height = 150, title = '', tip, showValues = false }) {
  const n = series[0].values.length;
  const totals = Array.from({ length: n }, (_, i) => series.reduce((s, x) => s + x.values[i], 0));
  const max = Math.max(4, ...totals);
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const L = 28, B = 20, T = showValues ? 14 : 8;
  const y = (v) => height - B - (v / top) * (height - B - T);
  const bw = (W - L) / n;
  let svg = '<svg viewBox="0 0 ' + W + ' ' + height + '" role="img" aria-label="' + escapeHtml(title) + '">';
  for (let v = 0; v <= top; v += step) {
    svg += '<line class="grid" x1="' + L + '" x2="' + W + '" y1="' + y(v) + '" y2="' + y(v) + '"/>' +
      '<text x="' + (L - 5) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + v + '</text>';
  }
  for (let i = 0; i < n; i++) {
    const x = L + i * bw + Math.min(2, bw * 0.15), w = Math.max(1.5, bw - 2 * Math.min(2, bw * 0.15));
    let acc = 0;
    const t = tip ? '<title>' + escapeHtml(tip(i)) + '</title>' : '';
    series.forEach((s, k) => {
      const v = s.values[i];
      if (!v) return;
      const gap = k > 0 && acc > 0 ? 1.5 : 0;
      const y1 = y(acc + v), y0 = y(acc) - gap;
      svg += '<rect class="' + s.cls + '" x="' + x + '" y="' + y1 + '" width="' + w + '" height="' + Math.max(0.5, y0 - y1) + '" rx="1.5">' + t + '</rect>';
      acc += v;
    });
    if (showValues && totals[i]) svg += '<text x="' + (x + w / 2) + '" y="' + (y(totals[i]) - 3) + '" text-anchor="middle">' + totals[i] + '</text>';
    const lab = labels(i);
    if (lab) svg += '<text x="' + (x + w / 2) + '" y="' + (height - 6) + '" text-anchor="middle">' + escapeHtml(lab) + '</text>';
  }
  return svg + '</svg>';
}
function legend(items) {
  return '<div class="chart-legend">' + items.map(([cls, label]) => '<span><i class="sw ' + cls + '"></i>' + escapeHtml(label) + '</span>').join('') + '</div>';
}

// Calendrier des 26 dernières semaines, une case par jour.
function heatmap(p) {
  const weeks = 26;
  const t = S.today();
  const [y, m, d] = t.split('-').map(Number);
  const dow = (new Date(y, m - 1, d).getDay() + 6) % 7; // 0 = lundi
  const start = S.addDays(t, -(weeks - 1) * 7 - dow);
  const cell = 11, gap = 2, L = 16, T = 14;
  const width = L + weeks * (cell + gap), height = T + 7 * (cell + gap);
  const counts = [];
  let max = 1;
  for (let i = 0; i < weeks * 7; i++) {
    const day = S.addDays(start, i);
    const r = day > t ? -1 : S.dayTotals(p, day).r;
    counts.push([day, r]);
    max = Math.max(max, r);
  }
  let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Jours de révision sur 26 semaines">';
  ['L', '', 'M', '', 'V', '', 'D'].forEach((l, i) => {
    if (l) svg += '<text x="0" y="' + (T + i * (cell + gap) + cell - 2) + '">' + l + '</text>';
  });
  let lastMonth = '';
  counts.forEach(([day, r], i) => {
    const col = Math.floor(i / 7), row = i % 7;
    const x = L + col * (cell + gap), yy = T + row * (cell + gap);
    if (row === 0) {
      const month = day.slice(5, 7);
      if (month !== lastMonth && col < weeks - 1) {
        svg += '<text x="' + x + '" y="9">' + new Date(day + 'T12:00').toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '') + '</text>';
        lastMonth = month;
      }
    }
    if (r < 0) return;
    const level = r === 0 ? 0 : Math.min(4, Math.ceil(r / max * 4));
    svg += '<rect class="hm' + level + '" x="' + x + '" y="' + yy + '" width="' + cell + '" height="' + cell + '" rx="2"><title>' +
      new Date(day + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }) + ' : ' + plural(r, 'réponse', 'réponses') + '</title></rect>';
  });
  return svg + '</svg>' + '<div class="chart-legend hm-legend"><span>Moins</span>' +
    [0, 1, 2, 3, 4].map((l) => '<i class="sw hm' + l + '"></i>').join('') + '<span>Plus</span></div>';
}

export function renderStats() {
  const p = state.progress;
  const t = S.today();
  const days = lastDays(30);
  const totals = days.map((d) => S.dayTotals(p, d));
  const sum = (k) => totals.reduce((s, x) => s + x[k], 0);
  const today = totals[totals.length - 1];
  const rv = totals.reduce((a, x) => [a[0] + x.rv[0], a[1] + x.rv[1]], [0, 0]);
  const g30 = totals.reduce((a, x) => a.map((v, i) => v + x.g[i]), [0, 0, 0, 0]);

  // État de toutes les faces.
  const states = { new: 0, learn: 0, young: 0, mature: 0 };
  const ivlHist = [0, 0, 0, 0, 0, 0, 0, 0];
  const ivlEdges = [1, 3, 7, 15, 31, 90, 180, Infinity];
  const ivlLabels = ['1 j', '2-3', '4-7', '8-15', '16-31', '1-3 m', '3-6 m', '6 m+'];
  const hard = [];
  state.chapters.forEach((ch) => S.faces(ch).forEach((f) => {
    const st = S.stateOf(p, f.key);
    if (!st) { states.new++; return; }
    if (st.state !== 'review') states.learn++;
    else if (st.ivl >= 21) states.mature++;
    else states.young++;
    if (st.state === 'review') ivlHist[ivlEdges.findIndex((e) => st.ivl <= e)]++;
    if ((st.l || 0) > 0) hard.push({ f, st });
  }));
  const allFaces = states.new + states.learn + states.young + states.mature;

  $('statTiles').innerHTML = [
    [streak(p), 'jours de suite'],
    [today.r, plural(today.r, 'réponse', 'réponses').replace(/^\d+ /, '') + ' aujourd\'hui · ' + fmtMin(today.t)],
    [pct(rv[1], rv[0]), 'de rétention sur 30 jours'],
    [states.mature + ' / ' + allFaces, 'cartes acquises (21 j et plus)'],
  ].map(([v, l]) => '<div class="tile"><div class="v">' + v + '</div><div class="l">' + l + '</div></div>').join('');

  $('heatmap').innerHTML = heatmap(p);

  // Réponses par jour.
  const labels30 = (i) => (i === days.length - 1 ? 'auj.' : i % 7 === 1 ? shortDate(days[i]) : null);
  $('chart30').innerHTML = barChart({
    title: 'Réponses par jour sur 30 jours',
    series: [{ values: totals.map((x) => x.c), cls: 'c-good' }, { values: totals.map((x) => x.r - x.c), cls: 'c-bad' }],
    labels: labels30,
    tip: (i) => shortDate(days[i]) + ' : ' + totals[i].c + ' réussies, ' + (totals[i].r - totals[i].c) + ' à revoir',
  }) + legend([['c-good', 'Réussies'], ['c-bad', 'À revoir']]) +
    '<p class="sub">' + plural(sum('r'), 'réponse', 'réponses') + ' en 30 jours, ' + pct(sum('c'), sum('r')) + ' réussies.</p>';

  // Temps passé.
  const tMin = totals.map((x) => Math.round(x.t / 60000));
  const active = totals.filter((x) => x.r).length;
  $('chartTime').innerHTML = barChart({
    title: 'Minutes de révision par jour', series: [{ values: tMin, cls: 'c-acc' }], labels: labels30,
    tip: (i) => shortDate(days[i]) + ' : ' + fmtMin(totals[i].t),
  }) + '<p class="sub">' + fmtMin(sum('t')) + ' en 30 jours' + (active ? ', ' + fmtMin(sum('t') / active) + ' par jour de révision' : '') +
    (sum('r') ? ', ' + Math.round(sum('t') / sum('r') / 1000) + ' s par carte en moyenne' : '') + '.</p>';

  // Boutons utilisés.
  const gTot = g30.reduce((a, b) => a + b, 0);
  const gNames = ['À revoir', 'Difficile', 'Correct', 'Facile'];
  $('chartButtons').innerHTML = '<div class="hbars">' + g30.map((v, i) =>
    '<div class="hbar"><span class="hl">' + gNames[i] + '</span><span class="track"><span class="fillb g' + (i + 1) + '" style="width:' + (gTot ? v / gTot * 100 : 0) + '%"></span></span><span class="hv">' + v + ' · ' + pct(v, gTot) + '</span></div>').join('') + '</div>' +
    '<p class="sub">Rétention réelle sur les cartes en révision : ' + pct(rv[1], rv[0]) + ' (objectif ' + Math.round(p.settings.retention * 100) + ' %).</p>';

  // État des cartes.
  const stateParts = [['new', 'Jamais vues', 'st-new'], ['learn', 'En apprentissage', 'st-learn'], ['young', 'Jeunes (< 21 j)', 'st-young'], ['mature', 'Acquises (21 j et plus)', 'st-mature']];
  $('chartStates').innerHTML = '<div class="stack big">' + stateParts.map(([k, , cls]) =>
    states[k] ? '<div class="' + cls + '" style="width:' + (states[k] / Math.max(1, allFaces) * 100) + '%"></div>' : '').join('') + '</div>' +
    '<div class="state-list">' + stateParts.map(([k, label, cls]) => '<span><i class="sw ' + cls + '"></i>' + label + ' <b>' + states[k] + '</b></span>').join('') + '</div>';

  // Intervalles.
  $('chartIvl').innerHTML = barChart({
    title: 'Répartition des intervalles', series: [{ values: ivlHist, cls: 'c-acc' }], labels: (i) => ivlLabels[i], showValues: true,
    tip: (i) => ivlLabels[i] + ' : ' + ivlHist[i],
  }) + '<p class="sub">Temps avant la prochaine révision des cartes déjà apprises.</p>';

  // Prévision sur 30 jours.
  const next = Array.from({ length: 30 }, (_, i) => S.addDays(t, i));
  const fc = next.map(() => 0);
  activeChapters().forEach((ch) => S.faces(ch).forEach((f) => {
    const st = S.stateOf(p, f.key);
    if (!st) return;
    if (st.state !== 'review' || st.due <= t) { fc[0]++; return; }
    const i = S.daysBetween(t, st.due);
    if (i < 30) fc[i]++;
  }));
  const newTotal = state.matieres.reduce((s, m) => s + S.subjectLimits(p.settings, m.id).newPerDay, 0);
  $('forecast').innerHTML = barChart({
    title: 'Cartes prévues sur 30 jours', series: [{ values: fc, cls: 'c-acc' }],
    labels: (i) => (i === 0 ? 'auj.' : i % 7 === 0 ? shortDate(next[i]) : null),
    tip: (i) => shortDate(next[i]) + ' : ' + fc[i],
  }) + '<p class="sub">' + plural(fc.slice(0, 7).reduce((a, b) => a + b, 0), 'révision', 'révisions') + ' dans les 7 prochains jours, hors nouvelles cartes (jusqu\'à ' + newTotal + ' par jour).</p>';

  // Par matière.
  let html = '';
  state.matieres.forEach((m) => {
    if (!m.chapitres.length) return;
    let r = 0, c = 0, time = 0;
    totals.forEach((x) => { if (x.m[m.id]) { r += x.m[m.id][0]; c += x.m[m.id][1]; } time += x.mt[m.id] || 0; });
    const counts = new Array(S.BUCKETS.length).fill(0);
    m.chapitres.forEach((ch) => S.faces(ch).forEach((f) => { counts[S.bucketOf(S.stateOf(p, f.key))]++; }));
    const n = counts.reduce((a, b) => a + b, 0) || 1;
    html += '<div class="mat-stat"><div class="head"><h3>' + escapeHtml(m.nom) + '</h3><span>' +
      (r ? pct(c, r) + ' réussies · ' + plural(r, 'réponse', 'réponses') + ' · ' + fmtMin(time) : 'pas de révision sur 30 jours') +
      '</span></div><div class="stack" title="' + counts.map((v, i) => S.BUCKETS[i] + ' : ' + v).join(', ') + '">' +
      counts.map((v, i) => v ? '<div class="b' + i + '" style="width:' + (v / n * 100) + '%"></div>' : '').join('') + '</div></div>';
  });
  html += legend(S.BUCKETS.map((b, i) => ['b' + i, b]));
  $('statMatieres').innerHTML = html;

  // Cartes les plus souvent oubliées.
  hard.sort((a, b) => (b.st.l || 0) - (a.st.l || 0) || (b.st.D || 0) - (a.st.D || 0));
  const list = $('hardList');
  list.innerHTML = '';
  if (!hard.length) list.innerHTML = '<li class="empty">Aucune carte oubliée pour l\'instant.</li>';
  hard.slice(0, 10).forEach(({ f, st }) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = '<span class="q-wrap"><span class="where"></span><span class="q"></span></span><span class="meta">' + plural(st.l, 'oubli', 'oublis') + '</span>';
    b.querySelector('.where').textContent = f.chapter.matiereNom + ' · ' + f.chapter.nom + (f.rev ? ' · inversée' : '');
    b.querySelector('.q').textContent = faceContent(f).q;
    b.addEventListener('click', () => openFromElsewhere(f.chapter, f.card));
    li.appendChild(b);
    list.appendChild(li);
  });
  typeset(list);
}
