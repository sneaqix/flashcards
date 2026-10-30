// Notifications de rappel (Web Push). L'appli enregistre l'abonnement de chaque appareil et les
// réglages dans notifications/config.json du dépôt privé ; un workflow GitHub Actions de ce dépôt
// envoie les rappels (tools/notify.mjs). Sur iPhone, il faut ouvrir l'appli depuis l'écran d'accueil.
import { isConflict } from './github.js?v=20261030215123';
import { deviceId } from './store.js?v=20261030215123';
import { $, state, canSync } from './ui.js?v=20261030215123';

const CONFIG = 'notifications/config.json';
const VAPID = 'notifications/vapid.json';
const STATE = 'notifications/state.json';
const DEFAULTS = { revision: { on: true, hour: 18 }, serie: { on: true, hour: 21 } };
const HOURS = Array.from({ length: 19 }, (_, i) => i + 5); // de 5 h à 23 h

let cfg = null;          // dernière configuration lue (ou modifiée ici)
let gone = {};           // abonnements expirés signalés par le workflow
let publicKey = null;
let loading = null;
let pending = null;      // { settings?, devices: { id: device } } en attente d'écriture
let saveTimer = null;
let busy = false;

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || isIOS()) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  return 'PC';
}

function settingsOf(c) {
  const s = (c && c.settings) || {};
  return { revision: { ...DEFAULTS.revision, ...(s.revision || {}) }, serie: { ...DEFAULTS.serie, ...(s.serie || {}) }, updated: s.updated || 0 };
}

export function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker non enregistré', e));
}

async function load(force = false) {
  if (!canSync()) return null;
  if (cfg && !force) return cfg;
  if (loading) return loading;
  loading = (async () => {
    const repo = state.config.dataRepo;
    const [c, v, st] = await Promise.all([
      state.gh.getFile(repo, CONFIG),
      publicKey ? null : state.gh.getFile(repo, VAPID),
      state.gh.getFile(repo, STATE).catch(() => null),
    ]);
    cfg = c ? JSON.parse(c.text) : { devices: {} };
    cfg.devices = cfg.devices || {};
    if (v) publicKey = JSON.parse(v.text).publicKey;
    gone = st ? (JSON.parse(st.text).gone || {}) : {};
    if (pending) applyPending(cfg);
    return cfg;
  })();
  try { return await loading; } finally { loading = null; }
}

function applyPending(c, pend = pending) {
  if (!pend || !c) return c;
  if (pend.settings) c.settings = pend.settings;
  c.devices = c.devices || {};
  Object.entries(pend.devices || {}).forEach(([id, d]) => {
    const cur = c.devices[id];
    if (!cur || (cur.t || 0) <= d.t) c.devices[id] = d;
  });
  c.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || c.tz || 'Europe/Paris';
  return c;
}

function queue(change) {
  pending = pending || { devices: {} };
  if (change.settings) pending.settings = change.settings;
  if (change.device) pending.devices[change.device.id] = change.device.value;
  applyPending(cfg || (cfg = { devices: {} }));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save().catch(() => {}), change.now ? 0 : 700);
}

// Lit, fusionne avec les changements de cet appareil, écrit ; recommence en cas de conflit.
async function save() {
  if (!pending || !canSync()) return;
  const repo = state.config.dataRepo;
  const mine = pending;
  pending = null; // les changements faits pendant l'écriture repartent dans un nouvel envoi
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const f = await state.gh.getFile(repo, CONFIG);
      const remote = f ? JSON.parse(f.text) : { devices: {} };
      applyPending(remote, mine);
      await state.gh.putFile(repo, CONFIG, JSON.stringify(remote, null, 1) + '\n', f && f.sha, 'Notifications : réglages');
      cfg = applyPending(remote);
      setStatus('Enregistré.', 'ok');
      return;
    } catch (e) {
      if (!isConflict(e) || attempt === 2) {
        // On garde les changements pour le prochain essai.
        pending = pending ? { settings: pending.settings || mine.settings, devices: { ...mine.devices, ...pending.devices } } : mine;
        setStatus('Enregistrement impossible : ' + e.message, 'error');
        throw e;
      }
    }
  }
}

function setStatus(msg, kind = '') {
  const el = $('nfStatus');
  if (!el) return;
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

async function currentSub() {
  if (!supported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

function b64uToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

// ---------- Écran Réglages ----------
export async function renderNotifs() {
  const panel = $('notifPanel');
  if (!panel) return;
  fillHours();
  paintRows(settingsOf(cfg));
  await paintDevice();
  if (!canSync()) return;
  try {
    await load(true);
    paintRows(settingsOf(cfg));
    await paintDevice();
    changed();
  } catch (e) {
    setStatus('Lecture des réglages impossible : ' + e.message, 'error');
  }
}

function fillHours() {
  ['nfRevHour', 'nfSerHour'].forEach((id) => {
    const sel = $(id);
    if (sel.options.length) return;
    HOURS.forEach((h) => sel.add(new Option(h + ' h', String(h))));
  });
}

function paintRows(s) {
  const ok = canSync();
  $('nfRevOn').checked = s.revision.on;
  $('nfSerOn').checked = s.serie.on;
  $('nfRevHour').value = String(s.revision.hour);
  $('nfSerHour').value = String(s.serie.hour);
  $('nfRevOn').disabled = $('nfSerOn').disabled = !ok;
  $('nfRevHour').disabled = !ok || !s.revision.on;
  $('nfSerHour').disabled = !ok || !s.serie.on;
}

const changed = () => document.dispatchEvent(new Event('settings-summary'));

// Résumé pour la section repliée des Réglages.
export function notifSummary() {
  const parts = [];
  if ($('nfRevOn').checked) parts.push('révision ' + $('nfRevHour').value + ' h');
  if ($('nfSerOn').checked) parts.push('série ' + $('nfSerHour').value + ' h');
  const on = $('nfToggle').dataset.on === '1';
  const head = !canSync() ? 'GitHub non configuré' : on ? 'Activées' : 'Désactivées sur cet appareil';
  return head + (parts.length ? ' · ' + parts.join(', ') : '');
}

async function paintDevice() {
  const btn = $('nfToggle');
  const info = $('nfDeviceState');
  $('nfDeviceTitle').textContent = 'Cet appareil (' + deviceName() + ')';
  $('nfHowto').hidden = true;
  btn.hidden = true;
  if (isIOS() && !standalone()) {
    info.textContent = 'Sur iPhone, les notifications ne marchent que dans l\'appli ajoutée à l\'écran d\'accueil :';
    $('nfHowto').hidden = false;
    return;
  }
  if (!supported()) { info.textContent = 'Ce navigateur ne gère pas les notifications.'; return; }
  if (!canSync()) { info.textContent = 'Configure d\'abord la synchronisation GitHub (plus bas).'; return; }
  if (Notification.permission === 'denied') {
    info.textContent = isIOS()
      ? 'Notifications refusées. Autorise-les dans Réglages de l\'iPhone › Notifications › Flashcards.'
      : 'Notifications refusées. Autorise-les dans les réglages du navigateur pour ce site.';
    return;
  }
  const sub = await currentSub();
  const dev = cfg && cfg.devices[deviceId()];
  const on = !!(sub && dev && dev.on && dev.sub && dev.sub.endpoint === sub.endpoint && gone[sub.endpoint] == null);
  info.textContent = on ? 'Notifications activées.' : (sub && gone[sub.endpoint] != null ? 'Abonnement expiré : réactive-le.' : 'Notifications désactivées.');
  btn.textContent = on ? 'Désactiver' : 'Activer';
  btn.className = on ? 'ghost small' : 'primary small';
  btn.dataset.on = on ? '1' : '';
  btn.hidden = false;
  changed();
}

async function enable() {
  // La demande d'autorisation doit partir directement du toucher (exigence d'iOS).
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { await paintDevice(); return; }
  setStatus('Activation…');
  await load();
  if (!publicKey) { setStatus('Clé de notification absente du dépôt privé (notifications/vapid.json).', 'error'); return; }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && gone[sub.endpoint] != null) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
  queue({ device: { id: deviceId(), value: { name: deviceName(), on: true, sub: sub.toJSON(), t: Date.now() } }, now: true });
  await save();
  setStatus('Activé. Une notification de confirmation arrive d\'ici une minute ou deux.', 'ok');
  await paintDevice();
}

async function disable() {
  const sub = await currentSub();
  if (sub) await sub.unsubscribe().catch(() => {});
  queue({ device: { id: deviceId(), value: { name: deviceName(), on: false, t: Date.now() } }, now: true });
  await save();
  setStatus('Notifications désactivées sur cet appareil.', 'ok');
  await paintDevice();
}

function changeSettings() {
  const s = {
    revision: { on: $('nfRevOn').checked, hour: Number($('nfRevHour').value) },
    serie: { on: $('nfSerOn').checked, hour: Number($('nfSerHour').value) },
    updated: Date.now(),
  };
  paintRows(s);
  changed();
  queue({ settings: s });
}

// Si le navigateur a renouvelé l'abonnement, on met à jour le dépôt.
export async function checkSubscription() {
  try {
    if (!supported() || !canSync() || Notification.permission !== 'granted') return;
    const sub = await currentSub();
    if (!sub) return;
    await load();
    const dev = cfg.devices[deviceId()];
    if (dev && dev.on && dev.sub && dev.sub.endpoint !== sub.endpoint) {
      queue({ device: { id: deviceId(), value: { ...dev, sub: sub.toJSON(), t: Date.now() } } });
    }
  } catch (e) { /* sans gravité */ }
}

export function bindNotifs() {
  if (!$('notifPanel')) return;
  $('nfToggle').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    $('nfToggle').disabled = true;
    try {
      if ($('nfToggle').dataset.on) await disable(); else await enable();
    } catch (e) {
      setStatus('Échec : ' + e.message, 'error');
    } finally {
      busy = false;
      $('nfToggle').disabled = false;
    }
  });
  ['nfRevOn', 'nfSerOn', 'nfRevHour', 'nfSerHour'].forEach((id) => $(id).addEventListener('change', changeSettings));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pending) { clearTimeout(saveTimer); save().catch(() => {}); }
  });
}
