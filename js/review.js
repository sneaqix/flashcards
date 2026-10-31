// Accueil (révision du jour) et déroulement d'une session de révision.
import * as S from './store.js?v=20261031220645';
import {
  $, state, escapeHtml, textHtml, renderFace, typeset, toast, plural, saveProgress, activeChapters, dailyChapters, dailyOff,
  canEdit, faceContent, expectedAnswer, firstLine, chapterCounts, showView, goTab, clozeParts, isCloze, imageUrl,
} from './ui.js?v=20261031220645';
import { scheduleSync } from './sync.js?v=20261031220645';
import { renderTodo, examsAhead, openAgendaItem, TYPES, matColor } from './agenda.js?v=20261031220645';
import { docsOfChapter, showChapterDocs } from './classeur.js?v=20261031220645';
import { openEditor } from './editor.js?v=20261031220645';
import { startMixRound } from './practice.js?v=20261031220645';

const GRADE_LABELS = ['À revoir', 'Difficile', 'Correct', 'Facile'];

// =====================================================================
// Accueil
// =====================================================================
export function boxesHtml(counts) {
  const max = Math.max(1, ...counts);
  return '<div class="boxes">' + counts.map((n, i) =>
    '<div class="box" title="' + (i === 0 ? 'Jamais vues' : 'Palier ' + S.BUCKETS[i]) + ' : ' + n + '">' +
    '<div class="bar"><div class="fill" style="height:' + Math.round(n / max * 100) + '%"></div></div>' +
    '<span>' + S.BUCKETS[i] + '</span><span class="n">' + n + '</span></div>').join('') + '</div>';
}

function countsText(q) {
  const parts = [q.reviews + ' à revoir', plural(q.fresh, 'nouvelle', 'nouvelles')];
  if (q.learn) parts.push(q.learn + ' en cours');
  return parts.join(' · ');
}

// Lance la « Révision du jour » (bouton de l'accueil et de la barre latérale sur ordinateur).
// File du jour, préparation des DS et colles comprise.
export function dailyToday() {
  return S.dailyWithExams(state.progress, dailyChapters(), examsAhead(), state.byId);
}

export function startDailyReview() {
  const items = dailyToday().items;
  if (!items.length) { toast('Rien à réviser pour l\'instant.'); return; }
  startSession(items, 'srs', 'Révision du jour');
}

// Bandeau « Prépa DS » : avancement de chaque DS ou colle du calendrier.
function renderExamPlans(plans) {
  const box = $('examPlans');
  box.innerHTML = '';
  const fmt = (d) => new Date(d + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  const lines = [];
  plans.forEach((pl) => {
    const ex = pl.exam;
    let detail;
    if (!pl.total) {
      detail = 'Les chapitres choisis n\'ont pas encore de cartes.';
    } else if (pl.final) {
      detail = pl.items.length
        ? 'Dernière revue : ' + plural(pl.items.length, 'carte', 'cartes') + ' aujourd\'hui' + (pl.pendingLeft > pl.items.length ? ', ' + (pl.pendingLeft - pl.items.length) + ' les jours suivants' : '')
        : 'Dernière revue faite pour aujourd\'hui.';
      if (pl.freshLeft) detail += ' · ' + plural(pl.freshLeft, 'carte jamais vue', 'cartes jamais vues');
    } else if (pl.freshLeft) {
      detail = plural(pl.items.length, 'nouvelle carte', 'nouvelles cartes') + ' aujourd\'hui · ' + pl.freshLeft + ' à découvrir en tout';
    } else {
      detail = 'Tout est découvert. Dernière revue à partir du ' + fmt(S.addDays(ex.date, -S.EXAM_WINDOW)) + '.';
    }
    lines.push({ ex, days: pl.daysLeft, detail });
  });
  // DS et colles proches sans chapitres : rappel pour les compléter.
  examsAhead().filter((ex) => !(ex.chaps || []).length && S.daysBetween(S.today(), ex.date) <= 14)
    .forEach((ex) => lines.push({ ex, days: S.daysBetween(S.today(), ex.date), detail: 'Ajoute les chapitres qui tombent pour que la préparation commence.', missing: true }));
  box.hidden = !lines.length;
  lines.sort((a, b) => a.days - b.days);
  lines.forEach(({ ex, days, detail, missing }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'exam-plan' + (missing ? ' missing' : '');
    b.innerHTML = '<span class="ep-when"></span><span class="ep-main"><b></b><span class="ep-detail"></span></span>';
    b.querySelector('.ep-when').textContent = days === 1 ? 'demain' : 'J-' + days;
    b.querySelector('b').textContent = 'Prépa ' + TYPES[ex.type] + ' · ' + ex.title + ' · ' + fmt(ex.date);
    b.querySelector('.ep-detail').textContent = detail;
    b.setAttribute('aria-label', b.querySelector('b').textContent + '. ' + detail + ' Ouvrir dans le calendrier.');
    b.addEventListener('click', () => openAgendaItem(ex));
    box.appendChild(b);
  });
}

const phone = matchMedia('(max-width: 899px)');

export function renderHome() {
  const p = state.progress;
  $('date').textContent = new Date(Date.now() - 4 * 3600000).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  renderTodo($('todoBox'));
  const daily = dailyToday();
  $('dueTotal').textContent = daily.items.length;
  $('dueDetail').textContent = countsText({ reviews: daily.reviewsDue, fresh: daily.newAvailable, learn: daily.learn }) +
    (daily.extra ? ' · ' + daily.extra + ' pour les DS' : '');
  renderExamPlans(daily.plans);
  $('startDaily').disabled = daily.items.length === 0;

  const off = new Set(p.settings.inactive || []);
  const list = $('chapterList');
  list.innerHTML = '';
  if (!state.chapters.length) {
    list.innerHTML = '<p class="sub">Aucun chapitre pour l\'instant.</p>';
    return;
  }
  state.matieres.forEach((m) => {
    if (!m.chapitres.length) return;
    const total = m.chapitres.reduce((s, c) => s + c.cartes.length, 0);
    const activeHere = m.chapitres.filter((c) => !off.has(c.id));
    // Calculé à part : une matière exclue de la révision du jour garde ses propres cartes à faire.
    const sub = S.dailyQueue(p, activeHere).bySubject[m.id] || { reviews: 0, fresh: 0, learn: 0, total: 0 };
    const sec = document.createElement('div');
    sec.className = 'matiere';
    // Sur téléphone, la matière se déplie au toucher ; le bouton Réviser reste toujours visible.
    const allFaces = m.chapitres.flatMap((c) => S.faces(c));
    const seen = allFaces.filter((f) => S.stateOf(p, f.key)).length;
    sec.innerHTML = '<div class="matiere-head"><div class="mat-info"><span class="mat-dot" aria-hidden="true"></span><h2></h2><span class="mat-long">' + plural(total, 'carte', 'cartes') + ' · ' + countsText(sub) + '</span>' +
      '<span class="mat-sum"></span><span class="mat-bar" aria-hidden="true"><i></i></span><span class="mat-chev" aria-hidden="true"></span></div>' +
      '<button class="primary small subject-start" type="button">Réviser · ' + sub.total + '</button></div><ul class="chapters"></ul>';
    sec.querySelector('h2').textContent = m.nom;
    sec.querySelector('.mat-dot').style.background = matColor(m.id);
    sec.querySelector('.mat-sum').textContent = plural(m.chapitres.length, 'chapitre', 'chapitres') + ' · ' + sub.total + ' à faire' + (dailyOff().has(m.id) ? ' · à part' : '');
    sec.querySelector('.mat-bar i').style.width = (allFaces.length ? Math.round(seen / allFaces.length * 100) : 0) + '%';
    sec.querySelector('.mat-bar').title = seen + ' / ' + allFaces.length + ' cartes déjà vues';
    const info = sec.querySelector('.mat-info');
    info.tabIndex = 0;
    info.setAttribute('role', 'button');
    info.setAttribute('aria-expanded', 'false');
    const toggle = () => {
      if (!phone.matches) return;
      const open = !sec.classList.contains('open');
      list.querySelectorAll('.matiere.open').forEach((o) => { o.classList.remove('open'); o.querySelector('.mat-info').setAttribute('aria-expanded', 'false'); });
      sec.classList.toggle('open', open);
      info.setAttribute('aria-expanded', String(open));
      if (open) requestAnimationFrame(() => { const top = sec.getBoundingClientRect().top; if (top < 0 || top > innerHeight * 0.5) sec.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); });
    };
    info.addEventListener('click', toggle);
    info.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    if (dailyOff().has(m.id)) sec.querySelector('.mat-long').insertAdjacentHTML('beforeend', '<em class="off-daily"> · hors révision du jour</em>');
    const subjectBtn = sec.querySelector('.subject-start');
    subjectBtn.disabled = sub.total === 0;
    subjectBtn.setAttribute('aria-label', 'Réviser ' + m.nom + ' : ' + plural(sub.total, 'carte', 'cartes'));
    subjectBtn.addEventListener('click', () => startSession(S.dailyQueue(state.progress, activeHere).items, 'srs', m.nom));
    const ul = sec.querySelector('ul');
    m.chapitres.forEach((ch) => {
      const q = S.dailyQueue(p, [ch]);
      const li = document.createElement('li');
      li.className = 'chapter' + (off.has(ch.id) ? ' inactive' : '');
      li.innerHTML = '<div><h3></h3><div class="due"><b>' + q.items.length + '</b> à faire · ' +
        plural(ch.cartes.length, 'carte', 'cartes') + (off.has(ch.id) ? ' · hors révision du jour' : '') + '</div></div>' +
        '<button class="primary small" type="button">Réviser</button>' + boxesHtml(chapterCounts(ch));
      li.querySelector('h3').textContent = ch.nom;
      const docs = docsOfChapter(ch.id);
      if (docs.length) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'linklike';
        link.textContent = plural(docs.length, 'document', 'documents');
        link.addEventListener('click', () => showChapterDocs(ch.id));
        li.querySelector('.due').append(' · ', link);
      }
      const btn = li.querySelector('button');
      btn.disabled = q.items.length === 0;
      btn.addEventListener('click', () => startSession(S.dailyQueue(state.progress, [ch]).items, 'srs', ch.nom));
      ul.appendChild(li);
    });
    list.appendChild(sec);
  });
}

// =====================================================================
// Comparaison d'une réponse tapée
// =====================================================================
function norm(s) {
  return String(s).toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[’`]/g, '\'')
    .replace(/\s+/g, ' ').trim().replace(/[.!?;:,]+$/, '').trim();
}
function loose(s) {
  return norm(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/^(to|a|an|the|le|la|les|l'|un|une|des)\s*/, '').replace(/[^a-z0-9' ]/g, '').replace(/\s+/g, ' ').trim();
}
function levenshtein(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d;
}
// Alignement caractère par caractère : lettres justes, fausses, en trop ou manquantes.
function diffHtml(typed, expected) {
  const a = typed, b = expected;
  const d = levenshtein(a.toLowerCase(), b.toLowerCase());
  let i = a.length, j = b.length;
  const top = [], bottom = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1)) {
      const same = a[i - 1].toLowerCase() === b[j - 1].toLowerCase();
      top.unshift([a[i - 1], same ? 'ok' : 'bad']);
      bottom.unshift([b[j - 1], same ? 'ok' : 'miss']);
      i--; j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      top.unshift([a[i - 1], 'bad']); i--;
    } else {
      bottom.unshift([b[j - 1], 'miss']); j--;
    }
  }
  const render = (arr) => arr.map(([c, k]) => '<span class="d-' + k + '">' + escapeHtml(c) + '</span>').join('');
  return { typed: render(top), expected: render(bottom) };
}
export function checkTyped(input, expected) {
  const alts = [expected, ...expected.split(/\s*[\/;]\s*/)].map((x) => x.trim()).filter(Boolean);
  if (!input.trim()) return { verdict: 'empty', best: alts[0] };
  // Virgules facultatives entre les formes (« began, begun » = « began begun »).
  const nc = (x) => norm(x).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (alts.some((x) => nc(x) === nc(input))) return { verdict: 'exact', best: alts.find((x) => nc(x) === nc(input)) };
  if (alts.some((x) => loose(x) && loose(x) === loose(input))) return { verdict: 'close', best: alts.find((x) => loose(x) === loose(input)) };
  let best = alts[0], bestD = Infinity;
  alts.forEach((x) => {
    const dd = levenshtein(loose(input), loose(x));
    const dist = dd[dd.length - 1][dd[0].length - 1];
    if (dist < bestD) { bestD = dist; best = x; }
  });
  // Une petite faute de frappe (1 lettre, ou 2 sur un mot long) compte comme « presque ».
  if (bestD <= Math.max(1, Math.floor(loose(best).length / 8))) return { verdict: 'typo', best };
  return { verdict: 'wrong', best };
}

// =====================================================================
// Choix multiples
// =====================================================================
export function qcmOptions(item, count = 4) {
  const side = (card) => (item.rev ? firstLine(card.q) : expectedAnswer(card).split(' / ')[0]);
  const correct = side(item.card);
  if (!correct) return null;
  let wrong = [];
  if (!item.rev && Array.isArray(item.card.choix) && item.card.choix.length) {
    wrong = item.card.choix.filter((x) => x && x.trim() && x.trim() !== correct);
  } else {
    const pool = (cards) => S.shuffle(cards.filter((c) => c.id !== item.card.id && !isCloze(c)).map(side))
      .filter((x, i, arr) => x && x !== correct && arr.indexOf(x) === i);
    wrong = pool(item.chapter.cartes);
    if (wrong.length < count - 1) {
      const sameSubject = state.chapters.filter((c) => c.matiere === item.chapter.matiere && c.id !== item.chapter.id).flatMap((c) => c.cartes);
      wrong = [...wrong, ...pool(sameSubject).filter((x) => !wrong.includes(x))];
    }
  }
  wrong = S.shuffle(wrong).slice(0, count - 1);
  if (!wrong.length) return null;
  return { correct, options: S.shuffle([correct, ...wrong]) };
}

// =====================================================================
// Session
// =====================================================================
// mode : 'srs' (révision planifiée), 'cram' (bachotage) ou 'qcm' (bachotage en choix multiples).
export function startSession(items, mode, label) {
  if (!items.length) { toast('Rien à réviser ici pour aujourd\'hui.'); return; }
  const learn = [], main = [];
  items.forEach((it) => {
    const st = mode === 'srs' ? S.stateOf(state.progress, it.key) : null;
    if (st && st.state !== 'review') learn.push({ item: it, dueAt: st.dueAt || 0 });
    else main.push(it);
  });
  state.session = {
    mode, label, main, learn, total: items.length, answered: 0, firstOk: 0, time: 0,
    history: [], seen: new Set(), cur: null, shownAt: 0, view: null,
  };
  state.finished = null;
  state.lastMode = mode;
  $('modeLabel').textContent = mode === 'srs' ? label : mode === 'qcm' ? 'QCM' : mode === 'mix' ? 'Tout mélangé' : 'Bachotage';
  showView('session');
  nextCard();
}

function pickNext(s) {
  const now = Date.now();
  s.learn.sort((a, b) => a.dueAt - b.dueAt);
  if (s.learn.length && s.learn[0].dueAt <= now) return s.learn.shift().item;
  if (s.main.length) return s.main.shift();
  if (s.learn.length) return s.learn.shift().item; // plus rien d'autre : on la montre un peu en avance
  return null;
}

function remaining(s) {
  return s.main.length + s.learn.length + (s.cur ? 1 : 0);
}

// « Tout mélangé » : environ toutes les 8 cartes, une manche d'associations avec les cartes suivantes.
const MIX_EVERY = 8;
function takeAssocRound(s) {
  const picked = [], answers = new Set();
  for (const it of s.main) {
    if (picked.length === 5) break;
    if (it.rev || isCloze(it.card)) continue;
    const a = expectedAnswer(it.card);
    if (!a || answers.has(a)) continue;
    answers.add(a);
    picked.push(it);
  }
  if (picked.length < 3) return null;
  s.main = s.main.filter((it) => !picked.includes(it));
  return picked;
}

function nextCard() {
  const s = state.session;
  if (s.mode === 'mix') {
    s.sinceAssoc = (s.sinceAssoc || 0) + 1;
    if (s.sinceAssoc > MIX_EVERY) {
      const round = takeAssocRound(s);
      if (round) {
        s.sinceAssoc = 0;
        s.cur = null;
        startMixRound(round, (errors) => {
          s.answered += round.length;
          s.firstOk += Math.max(0, round.length - errors);
          showView('session');
          nextCard();
        });
        return;
      }
    }
  }
  s.cur = pickNext(s);
  if (!s.cur) return finishSession();
  showCurrent(false);
}

// « Tout mélangé » : chaque carte reçoit au hasard un format (retourner, QCM ou réponse à taper).
function pickMix(item) {
  const formats = ['classic', 'qcm'];
  const exp = expectedAnswer(item.card);
  if (!item.rev && exp && exp.length <= 40 && !exp.includes('$$')) formats.push('saisie');
  return formats[Math.floor(Math.random() * formats.length)];
}
function modeOf(s, item) {
  if (isCloze(item.card)) return 'trou';
  if (s.mode === 'qcm') return 'qcm';
  if (s.mode === 'mix') return item._mix || (item._mix = pickMix(item));
  if (!item.rev && (item.card.mode === 'saisie' || item.card.mode === 'qcm')) return item.card.mode;
  return 'classic';
}

// Affiche la carte courante. revealed : directement avec la réponse (après une annulation).
function showCurrent(revealed) {
  const s = state.session;
  const item = s.cur;
  const content = faceContent(item);
  const st = S.stateOf(state.progress, item.key);
  const tag = [item.chapter.matiereNom + ' · ' + item.chapter.nom];
  if (item.rev) tag.push('inversée');
  if (s.mode === 'srs') tag.push(!st ? 'nouvelle' : st.state === 'review' ? 'révision' : 'en cours');
  $('cardTag').textContent = tag.join(' · ');
  renderFace($('question'), content.q, content.img_q);
  $('answer').hidden = true;
  $('answer').innerHTML = '';
  $('compare').hidden = true;
  $('choices').hidden = true;
  $('typeBox').hidden = true;
  $('grade').hidden = true;
  $('show').hidden = false;
  document.querySelectorAll('.grade button').forEach((b) => b.classList.remove('suggest'));

  let mode = revealed ? 'classic' : modeOf(s, item);
  s.view = { mode, qcm: null };
  if (mode === 'qcm') {
    const q = qcmOptions(item);
    if (!q) mode = s.view.mode = 'classic';
    else {
      s.view.qcm = q;
      const box = $('choices');
      box.innerHTML = '';
      q.options.forEach((opt, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'choice';
        b.innerHTML = '<span class="k">' + (i + 1) + '</span><span class="t">' + textHtml(opt) + '</span>';
        b.addEventListener('click', () => chooseOption(opt, b));
        box.appendChild(b);
      });
      box.hidden = false;
      $('show').hidden = true;
      typeset(box);
    }
  }
  if (mode === 'trou') renderCloze(item);
  if (mode === 'saisie') {
    $('typeBox').hidden = false;
    $('typeInput').value = '';
    $('show').textContent = 'Vérifier';
    setTimeout(() => $('typeInput').focus({ preventScroll: true }), 30);
  } else if (mode === 'trou') {
    $('show').textContent = 'Vérifier';
  } else {
    $('show').textContent = 'Voir la réponse';
  }

  const rest = remaining(s);
  const toSee = s.main.length + 1;
  $('counter').textContent = plural(toSee, 'carte à voir', 'cartes à voir') + (s.learn.length ? ' · ' + s.learn.length + ' en cours d\'apprentissage' : '');
  $('progressBar').style.width = (s.answered / Math.max(1, s.answered + rest) * 100) + '%';
  $('undo').hidden = !s.history.length;
  $('editCard').hidden = false;
  s.shownAt = Date.now();
  if (revealed) reveal();
  else if (mode === 'classic') $('show').focus({ preventScroll: true });
}

function setGradeLabels() {
  const s = state.session;
  const ivls = s.mode === 'srs' ? S.previews(state.progress, s.cur) : null;
  [1, 2, 3, 4].forEach((g) => {
    $('g' + g).innerHTML = '<span>' + GRADE_LABELS[g - 1] + '</span>' + (ivls ? '<small>' + ivls[g - 1] + '</small>' : '');
  });
}

function reveal() {
  const s = state.session;
  if (!s || !$('answer').hidden) return;
  if (s.view.mode === 'saisie' && $('compare').hidden) return checkAnswer();
  if (s.view.mode === 'trou' && !s.view.checked) return checkCloze();
  const content = faceContent(s.cur);
  $('answer').hidden = false;
  renderFace($('answer'), content.r, content.img_r);
  $('show').hidden = true;
  $('typeBox').hidden = true;
  setGradeLabels();
  $('grade').hidden = false;
}

function suggest(g) {
  document.querySelectorAll('.grade button').forEach((b) => b.classList.toggle('suggest', b.id === 'g' + g));
}

function checkAnswer() {
  const s = state.session;
  const typed = $('typeInput').value;
  const expected = expectedAnswer(s.cur.card);
  const res = checkTyped(typed, expected);
  const box = $('compare');
  const title = { exact: 'Exact', close: 'Presque : vérifie les accents ou l\'article', typo: 'Presque : une petite faute', wrong: 'Pas tout à fait', empty: 'Pas de réponse' }[res.verdict];
  const d = diffHtml(typed.trim(), res.best);
  box.className = 'compare ' + res.verdict;
  box.innerHTML = '<p class="verdict">' + title + '</p>' +
    (typed.trim() ? '<p class="line"><span class="lbl">Ta réponse</span><span class="txt">' + (res.verdict === 'exact' ? escapeHtml(typed.trim()) : d.typed) + '</span></p>' : '') +
    '<p class="line"><span class="lbl">Attendu</span><span class="txt">' + (res.verdict === 'exact' ? escapeHtml(res.best) : d.expected) + '</span></p>';
  box.hidden = false;
  reveal();
  suggest(res.verdict === 'exact' ? 3 : res.verdict === 'close' || res.verdict === 'typo' ? 2 : 1);
}

// ---------- Texte à trous : une case à remplir par trou, directement dans la phrase ----------
function renderCloze(item) {
  const q = $('question');
  q.innerHTML = '';
  let n = 0;
  clozeParts(item.card.q).forEach((p) => {
    if (p.answer === undefined) {
      p.text.split('\n').forEach((line, i) => {
        if (i) q.appendChild(document.createElement('br'));
        q.appendChild(document.createTextNode(line));
      });
      return;
    }
    const wrap = document.createElement('span');
    wrap.className = 'blank-wrap';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'blank';
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.dataset.answer = p.answer;
    input.placeholder = p.hint || '…';
    input.setAttribute('aria-label', 'Trou ' + (++n) + (p.hint ? ' : ' + p.hint : ''));
    input.style.width = Math.max(4, Math.min(22, Math.max(p.answer.split('/')[0].trim().length, (p.hint || '').length) + 2)) + 'ch';
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const all = [...q.querySelectorAll('input.blank')];
      const next = all[all.indexOf(input) + 1];
      if (next) next.focus(); else checkCloze();
    });
    wrap.appendChild(input);
    q.appendChild(wrap);
  });
  if (item.card.img_q) {
    const im = new Image();
    im.alt = '';
    im.src = imageUrl(item.card.img_q);
    q.appendChild(im);
  }
  state.session.view.checked = false;
  const first = q.querySelector('input.blank');
  if (first) setTimeout(() => first.focus({ preventScroll: true }), 30);
}
function checkCloze() {
  const s = state.session;
  let worst = 3;
  $('question').querySelectorAll('input.blank').forEach((input) => {
    const res = checkTyped(input.value, input.dataset.answer);
    input.disabled = true;
    input.classList.add(res.verdict === 'exact' ? 'b-ok' : res.verdict === 'close' || res.verdict === 'typo' ? 'b-near' : 'b-bad');
    if (res.verdict !== 'exact') {
      const fix = document.createElement('span');
      fix.className = 'blank-fix';
      fix.textContent = input.dataset.answer.split('/')[0].trim();
      input.parentNode.appendChild(fix);
    }
    worst = Math.min(worst, res.verdict === 'exact' ? 3 : res.verdict === 'close' || res.verdict === 'typo' ? 2 : 1);
  });
  s.view.checked = true;
  reveal();
  suggest(worst);
}

function chooseOption(opt, btn) {
  const s = state.session;
  if (!s || !$('answer').hidden) return;
  const ok = opt === s.view.qcm.correct;
  document.querySelectorAll('#choices .choice').forEach((b) => {
    b.disabled = true;
    if (b.querySelector('.t').textContent === s.view.qcm.correct || b === btn && ok) b.classList.add('right');
  });
  if (!ok) btn.classList.add('wrong');
  // Repère la bonne option même si son texte contient des formules mises en forme.
  const idx = s.view.qcm.options.indexOf(s.view.qcm.correct);
  document.querySelectorAll('#choices .choice')[idx].classList.add('right');
  reveal();
  suggest(ok ? 3 : 1);
}

function grade(g) {
  const s = state.session;
  if (!s || !s.cur || $('answer').hidden) return;
  const item = s.cur;
  const ms = Date.now() - s.shownAt;
  const snapshot = {
    cur: item, main: s.main.slice(), learn: s.learn.map((e) => ({ ...e })),
    answered: s.answered, firstOk: s.firstOk, time: s.time, seen: new Set(s.seen), undo: null,
  };
  const first = !s.seen.has(item.key);
  s.seen.add(item.key);
  s.time += Math.min(ms, 60000);
  if (s.mode === 'srs') {
    snapshot.undo = S.recordAnswer(state.progress, item, g, first, ms);
    saveProgress();
    scheduleSync(20000); // sauvegarde régulière pendant une longue session
    const st = state.progress.cards[item.key];
    if (st.state !== 'review') s.learn.push({ item: { ...item, kind: 'learn' }, dueAt: st.dueAt });
    else s.answered++;
  } else if (g === 1) {
    s.main.splice(Math.min(3, s.main.length), 0, item); // la carte revient un peu plus loin
  } else {
    s.answered++;
  }
  if (first && g > 1) s.firstOk++;
  s.history.push(snapshot);
  if (s.history.length > 50) s.history.shift();
  s.cur = null;
  nextCard();
}

function finishSession() {
  const s = state.session;
  const min = Math.round(s.time / 60000);
  $('doneText').textContent = plural(s.answered, 'carte terminée', 'cartes terminées') + ', ' +
    plural(s.firstOk, 'sue', 'sues') + ' du premier coup' + (min ? ', en ' + min + ' min' : '') + '.' +
    (s.mode !== 'srs' ? ' Ta progression n\'a pas été modifiée.' : '');
  state.finished = s;
  $('doneUndo').hidden = !s.history.length;
  state.session = null;
  if (s.mode === 'srs') scheduleSync(0);
  showView('done');
  $('back').focus({ preventScroll: true });
}

// Revient à la carte précédente : annule la dernière réponse et réaffiche la carte, réponse visible.
export function undoLast() {
  if (!state.session && state.finished) {
    state.session = state.finished;
    state.finished = null;
    showView('session');
  }
  const s = state.session;
  if (!s || !s.history.length) return;
  const snap = s.history.pop();
  if (snap.undo) {
    S.undoAnswer(state.progress, snap.undo);
    saveProgress();
    scheduleSync(20000);
  }
  Object.assign(s, { cur: snap.cur, main: snap.main, learn: snap.learn, answered: snap.answered, firstOk: snap.firstOk, time: snap.time, seen: snap.seen });
  showCurrent(true);
  toast('Réponse annulée : choisis à nouveau.');
}

export function leaveSession() {
  const wasSrs = state.session && state.session.mode === 'srs';
  state.session = null;
  state.finished = null;
  if (wasSrs) scheduleSync(0);
  goTab(state.lastMode === 'srs' ? 'reviser' : 'bachotage');
}

// ---------- Modifier la carte pendant la révision ----------
function editCurrent() {
  const s = state.session;
  if (!s || !s.cur) return;
  if (!canEdit()) { toast('Renseigne ton jeton GitHub dans les réglages pour modifier les cartes.'); return; }
  state.editReturn = 'session';
  openEditor(s.cur.chapter, s.cur.card);
}
// Appelé par l'éditeur au retour : card est la carte enregistrée, null si supprimée, undefined si inchangée.
export function resumeSession(card) {
  const s = state.session;
  state.editReturn = null;
  if (!s) return goTab('reviser');
  showView('session');
  if (card === undefined) return showCurrent(!$('answer').hidden);
  const id = s.cur.card.id;
  const patch = (it) => (it.card.id === id && it.chapter === s.cur.chapter ? { ...it, card } : it);
  if (card === null) {
    const drop = (it) => !(it.card.id === id && it.chapter === s.cur.chapter);
    s.main = s.main.filter(drop);
    s.learn = s.learn.filter((e) => drop(e.item));
    s.cur = null;
    return nextCard();
  }
  s.main = s.main.map(patch);
  s.learn = s.learn.map((e) => ({ ...e, item: patch(e.item) }));
  s.cur = patch(s.cur);
  showCurrent(false);
}

export function bindReview() {
  $('startDaily').addEventListener('click', startDailyReview);
  $('show').addEventListener('click', reveal);
  // Toucher la carte la retourne (comme « Voir la réponse »).
  $('card').addEventListener('click', (e) => {
    if ($('show').hidden || $('show').textContent !== 'Voir la réponse') return;
    if (e.target.closest('button, a, input, textarea, select, label')) return;
    if (window.getSelection && String(window.getSelection())) return;
    reveal();
  });
  [1, 2, 3, 4].forEach((g) => $('g' + g).addEventListener('click', () => grade(g)));
  $('quit').addEventListener('click', leaveSession);
  $('back').addEventListener('click', leaveSession);
  $('undo').addEventListener('click', undoLast);
  $('doneUndo').addEventListener('click', undoLast);
  $('editCard').addEventListener('click', editCurrent);
  $('typeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); checkAnswer(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'Backspace' && (state.session || (state.finished && !$('view-done').hidden))) {
      e.preventDefault();
      undoLast();
      return;
    }
    const s = state.session;
    if (!s || $('view-session').hidden) return;
    const revealed = !$('answer').hidden;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!revealed) reveal(); else grade(3);
    } else if (revealed && ['1', '2', '3', '4'].includes(e.key)) grade(Number(e.key));
    else if (!revealed && s.view && s.view.mode === 'qcm' && /^[1-9]$/.test(e.key)) {
      const b = document.querySelectorAll('#choices .choice')[Number(e.key) - 1];
      if (b) b.click();
    } else if (revealed && e.key === 'ArrowRight') grade(3);
    else if (revealed && e.key === 'ArrowLeft') grade(1);
    else if (e.key === 'e' || e.key === 'E') editCurrent();
    else if (e.key === 'Escape') leaveSession();
  });
}
