// Emploi du temps de Mon Bureau Numérique (Skolengo), récupéré par le workflow edt.yml du dépôt privé.
// L'appli lit edt/edt.json ; le jeton (edt/auth.json) se colle dans les Réglages.
import { $, state, escapeHtml, toast, canSync, setStatus, showView } from './ui.js?v=20261031175012';

const DATA = 'edt/edt.json';
const AUTH = 'edt/auth.json';
const LS = 'fc.edt';
const DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

let edt = readLocal();
let monday = mondayOf(new Date());
let selDay = todayIdx();
let loading = null;

function readLocal() { try { return JSON.parse(localStorage.getItem(LS)) || null; } catch (e) { return null; } }
function saveLocal() { try { localStorage.setItem(LS, JSON.stringify(edt)); } catch (e) { /* plein */ } }
function mondayOf(d) { const x = new Date(d); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function todayIdx() { const d = new Date().getDay(); return d === 0 ? 0 : Math.min(5, d - 1); }
const hm = (s) => new Date(s).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const desk = matchMedia('(min-width: 900px)');

async function load() {
  if (!canSync()) return edt;
  if (loading) return loading;
  loading = (async () => {
    try {
      const f = await state.gh.getFile(state.config.dataRepo, DATA);
      if (f) { edt = JSON.parse(f.text); saveLocal(); }
    } catch (e) { console.warn('Emploi du temps non lu', e); }
    return edt;
  })();
  try { return await loading; } finally { loading = null; }
}

function thisWeek() {
  // Le dimanche, on montre directement la semaine qui commence.
  const now = new Date();
  monday = mondayOf(now.getDay() === 0 ? addDays(now, 1) : now);
  selDay = now.getDay() === 0 ? 0 : todayIdx();
}

export async function openEdt() {
  thisWeek();
  showView('edt');
  render();
  await load();
  if (!$('view-edt').hidden) render();
}

function lessonsOf(day) {
  const key = ymd(day);
  return ((edt && edt.lessons) || []).filter((l) => ymd(new Date(l.start)) === key);
}

function lessonHtml(l) {
  const meta = [l.room, (l.teachers || []).join(', ')].filter(Boolean).map(escapeHtml).join(' · ');
  return '<li class="edt-lesson' + (l.canceled ? ' canceled' : '') + '" style="--c:' + escapeHtml(l.color || 'var(--accent)') + '">' +
    '<span class="edt-time">' + hm(l.start) + '<br><small>' + hm(l.end) + '</small></span>' +
    '<span class="edt-body"><b>' + escapeHtml(l.title) + '</b>' + (l.canceled ? '<em> · annulé</em>' : '') +
    (meta ? '<small>' + meta + '</small>' : '') + '</span></li>';
}

function render() {
  const box = $('edtBody');
  const days = Array.from({ length: 6 }, (_, i) => addDays(monday, i));
  const sat = lessonsOf(days[5]).length > 0;
  const shown = sat ? days : days.slice(0, 5);
  const cur = Math.min(selDay, shown.length - 1); // le samedi n'apparaît que s'il y a cours
  $('edtWeek').textContent = 'Semaine du ' + monday.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  const todayKey = ymd(new Date());
  // Onglets des jours (téléphone)
  const tabs = $('edtDays');
  tabs.innerHTML = '';
  shown.forEach((d, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = (i === cur ? 'on' : '') + (ymd(d) === todayKey ? ' today' : '');
    b.innerHTML = '<span>' + DAYS[i].slice(0, 3) + '</span><b>' + d.getDate() + '</b>';
    b.setAttribute('aria-pressed', String(i === cur));
    b.setAttribute('aria-label', DAYS[i] + ' ' + d.getDate());
    b.addEventListener('click', () => { selDay = i; render(); });
    tabs.appendChild(b);
  });
  // Colonnes (ordinateur) ou jour choisi (téléphone)
  box.innerHTML = '';
  box.style.gridTemplateColumns = desk.matches ? 'repeat(' + shown.length + ', minmax(0, 1fr))' : '';
  (desk.matches ? shown.map((d, i) => [d, i]) : [[shown[cur], cur]]).forEach(([d, i]) => {
    const col = document.createElement('section');
    col.className = 'edt-day' + (ymd(d) === todayKey ? ' today' : '');
    const ls = lessonsOf(d);
    col.innerHTML = '<h2>' + DAYS[i] + ' ' + d.getDate() + '</h2>' +
      (ls.length ? '<ul>' + ls.map(lessonHtml).join('') + '</ul>' : '<p class="edt-none">Pas de cours</p>');
    box.appendChild(col);
  });
  // État
  const st = $('edtState');
  if (!edt || !edt.updated) {
    st.innerHTML = 'Pas encore d\'emploi du temps. Colle ton jeton Mon Bureau Numérique dans <a href="#parametres">Réglages › Emploi du temps</a>.';
    st.className = 'edt-state warn';
  } else {
    const when = new Date(edt.updated).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    st.textContent = (edt.error ? edt.error + ' Dernière mise à jour réussie : ' : 'Mis à jour ') + when + '.';
    st.className = 'edt-state' + (edt.error ? ' warn' : '');
  }
}

function step(n) { monday = addDays(monday, 7 * n); render(); }

// ---------- Réglages : jeton ----------
export async function renderEdtSettings() {
  if (!$('edtToken')) return;
  const cur = edt && edt.updated ? 'Dernière mise à jour : ' + new Date(edt.updated).toLocaleString('fr-FR') + (edt.error ? '. ' + edt.error : '.') : '';
  if (!$('edtTokStatus').textContent) setStatus('edtTokStatus', cur, edt && edt.error ? 'error' : '');
}
export function edtSummary() {
  if (!edt || !edt.updated) return 'Non connecté';
  return edt.error ? 'À reconnecter' : 'Connecté · ' + ((edt.lessons || []).length) + ' cours';
}

async function saveToken() {
  const raw = $('edtToken').value.trim();
  let auth;
  try { auth = JSON.parse(raw); } catch (e) { setStatus('edtTokStatus', 'Ce n\'est pas le texte affiché par scolengo-token (il commence par une accolade « { »).', 'error'); return; }
  if (!auth || !auth.tokenSet || !auth.tokenSet.refresh_token || !auth.school || !auth.school.id) {
    setStatus('edtTokStatus', 'Jeton incomplet : copie tout le texte affiché par scolengo-token.', 'error');
    return;
  }
  if (!canSync()) { setStatus('edtTokStatus', 'Configure d\'abord la synchronisation GitHub.', 'error'); return; }
  $('edtSave').disabled = true;
  try {
    let sha = null;
    try { const f = await state.gh.getFile(state.config.dataRepo, AUTH); sha = f && f.sha; } catch (e) { /* nouveau */ }
    await state.gh.putFile(state.config.dataRepo, AUTH, JSON.stringify({ tokenSet: auth.tokenSet, school: auth.school }, null, 1) + '\n', sha, 'Emploi du temps : nouveau jeton');
    $('edtToken').value = '';
    setStatus('edtTokStatus', 'Jeton enregistré. L\'emploi du temps arrive dans une ou deux minutes (Calendrier › Emploi du temps).', 'ok');
    toast('Jeton enregistré.');
  } catch (e) {
    setStatus('edtTokStatus', 'Enregistrement impossible : ' + e.message, 'error');
  } finally {
    $('edtSave').disabled = false;
  }
}

export function bindEdt() {
  if (!$('view-edt')) return;
  $('agEdt').addEventListener('click', openEdt);
  $('edtBack').addEventListener('click', () => { showView('calendrier'); state.views.calendrier(); });
  $('edtPrev').addEventListener('click', () => step(-1));
  $('edtNext').addEventListener('click', () => step(1));
  $('edtToday').addEventListener('click', () => { thisWeek(); render(); });
  $('edtRefresh').addEventListener('click', async () => { toast('Actualisation…'); await load(); render(); });
  desk.addEventListener('change', () => { if (!$('view-edt').hidden) render(); });
  if ($('edtSave')) $('edtSave').addEventListener('click', saveToken);
  // Glisser à gauche / à droite sur téléphone : jour suivant / précédent.
  let x0 = null;
  $('edtBody').addEventListener('touchstart', (e) => { x0 = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
  $('edtBody').addEventListener('touchend', (e) => {
    if (x0 === null || desk.matches) return;
    const dx = e.changedTouches[0].clientX - x0;
    x0 = null;
    if (Math.abs(dx) < 60) return;
    const n = $('edtDays').children.length;
    if (dx < 0) { if (selDay < n - 1) selDay++; else { step(1); selDay = 0; } }
    else if (selDay > 0) selDay--; else { step(-1); selDay = n - 1; }
    render();
  });
}
