// Comptes : écran de connexion / inscription, section « Compte » des Réglages,
// et pages réservées (Notes, Emploi du temps, Notifications) selon le compte.
import { $, state, setStatus, toast } from './ui.js?v=20261111105254';
import { SupaStore, readSession, signIn, signUp, signOut, changePassword } from './supa.js?v=20261111105254';

const LS_OWNER = 'fc.owner';
// Données locales propres à un compte : effacées quand un autre compte se connecte sur cet appareil.
const PER_ACCOUNT = ['fc.progress.v2', 'fc.agenda', 'fc.edt', 'fc.notes', 'fc.importDraft', 'fc.clsMat'];
const PER_ACCOUNT_PREFIX = ['fc.ann.', 'fc.carnet.', 'fc.lastPage.'];

export const isSupabase = () => !!(state.gh && state.gh.kind === 'supabase');

// Au démarrage : session Supabase enregistrée → on l'utilise. Renvoie vrai si connecté.
export function startSession() {
  const s = readSession();
  if (!s) return false;
  state.gh = new SupaStore(s);
  return true;
}

function clearLocalIfOtherAccount(userId) {
  let prev = null;
  try { prev = localStorage.getItem(LS_OWNER); } catch (e) { /* rien */ }
  if (prev === userId) return false;
  try {
    PER_ACCOUNT.forEach((k) => localStorage.removeItem(k));
    Object.keys(localStorage).filter((k) => PER_ACCOUNT_PREFIX.some((p) => k.startsWith(p))).forEach((k) => localStorage.removeItem(k));
    localStorage.setItem(LS_OWNER, userId);
  } catch (e) { /* rien */ }
  return prev !== null || true;
}

// Profil du compte (identifiant, pages réservées) : lu au démarrage, gardé en mémoire.
export async function loadProfile() {
  if (!isSupabase()) { state.profile = null; applyFeatures(); return; }
  try {
    state.profile = await state.gh.profile();
  } catch (e) {
    state.profile = state.profile || null;
  }
  applyFeatures();
}

// Une page réservée n'est montrée qu'aux comptes qui y ont droit (en mode GitHub : tout est montré).
export function hasFeature(name) {
  if (!isSupabase()) return true;
  return !!(state.profile && state.profile.features && state.profile.features[name]);
}

export function applyFeatures() {
  const notes = hasFeature('notes');
  document.querySelectorAll('a[href="#notes"]').forEach((a) => { a.hidden = !notes; });
  const notifs = hasFeature('notifs');
  const np = $('notifPanel');
  if (np) np.hidden = !notifs;
  // Emploi du temps : bouton pour les comptes qui en ont un ; réglage du jeton Skolengo pour le propriétaire seulement.
  if ($('agEdt')) $('agEdt').hidden = !hasFeature('edt');
  const edtSet = document.querySelector('[data-acc="edt"]');
  if (edtSet) edtSet.hidden = !hasFeature('edtSync');
  const gh = document.querySelector('[data-acc="github"]');
  if (gh) gh.hidden = isSupabase() || !state.config.token;
  renderAccount();
}

// ---------- Écran de connexion ----------
let gateMode = 'login';
function paintGate() {
  const signup = gateMode === 'signup';
  $('authTitle').textContent = signup ? 'Créer un compte' : 'Se connecter';
  $('authInviteRow').hidden = !signup;
  $('authPass2Row').hidden = !signup;
  $('authSubmit').textContent = signup ? 'Créer mon compte' : 'Se connecter';
  $('authSwitch').textContent = signup ? 'J\'ai déjà un compte' : 'Créer un compte';
  $('authPass').autocomplete = signup ? 'new-password' : 'current-password';
  setStatus('authStatus', '');
}

export function showGate(mode = 'login') {
  gateMode = mode;
  paintGate();
  $('authGate').hidden = false;
  document.body.classList.add('gated');
  setTimeout(() => $('authUser').focus(), 50);
}
export function hideGate() {
  $('authGate').hidden = true;
  document.body.classList.remove('gated');
}

async function submitGate(e) {
  e.preventDefault();
  const user = $('authUser').value.trim(), pass = $('authPass').value;
  $('authSubmit').disabled = true;
  setStatus('authStatus', gateMode === 'signup' ? 'Création du compte…' : 'Connexion…');
  try {
    if (gateMode === 'signup' && pass !== $('authPass2').value) throw new Error('Les deux mots de passe sont différents.');
    const s = gateMode === 'signup' ? await signUp(user, pass, $('authInvite').value) : await signIn(user, pass);
    clearLocalIfOtherAccount(s.user.id);
    setStatus('authStatus', 'Connecté. Chargement de tes cartes…', 'ok');
    location.reload();
  } catch (err) {
    const msg = /invitation invalide|Database error/i.test(err.message) ? 'Inscription refusée (code d\'invitation ou identifiant).' : err.message;
    setStatus('authStatus', msg, 'error');
    $('authSubmit').disabled = false;
  }
}

// ---------- Section « Compte » des Réglages ----------
function renderAccount() {
  const box = $('accountBody');
  if (!box) return;
  const on = isSupabase();
  $('accIn').hidden = !on;
  $('accOut').hidden = on;
  const sum = $('sum-compte');
  if (on) {
    const name = (state.profile && state.profile.username) || '…';
    $('accName').textContent = name;
    if (sum) sum.textContent = 'Connecté : ' + name;
  } else if (sum) {
    sum.textContent = state.config.token ? 'Synchronisation GitHub (ancien mode)' : 'Non connecté';
  }
}

async function logout() {
  if (!confirm('Se déconnecter de cet appareil ? Tes cartes et ta progression restent enregistrées sur ton compte.')) return;
  await signOut(state.gh);
  location.reload();
}

async function newPassword() {
  const a = $('accPass').value, b = $('accPass2').value;
  if (a !== b) { setStatus('accStatus', 'Les deux mots de passe sont différents.', 'error'); return; }
  try {
    await changePassword(state.gh, a);
    $('accPass').value = $('accPass2').value = '';
    setStatus('accStatus', 'Mot de passe changé.', 'ok');
  } catch (e) {
    setStatus('accStatus', e.message, 'error');
  }
}

export function bindAccount() {
  if (!$('authGate')) return;
  $('authForm').addEventListener('submit', submitGate);
  $('authSwitch').addEventListener('click', () => { gateMode = gateMode === 'signup' ? 'login' : 'signup'; paintGate(); });
  $('accLogin').addEventListener('click', () => showGate('login'));
  $('accLogout').addEventListener('click', logout);
  $('accPassSave').addEventListener('click', newPassword);
  document.addEventListener('session-expired', () => { toast('Session expirée : reconnecte-toi.'); showGate('login'); });
}
