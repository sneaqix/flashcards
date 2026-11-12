// Comptes et données sur Supabase (sans bibliothèque : appels directs à son API).
// SupaStore imite l'objet GitHub (getFile, putFile, getBinary, deleteFile) : le reste de l'appli
// lit et écrit ses « fichiers » JSON de la même façon, mais dans la table docs du compte connecté.
import { GitHubError } from './github.js?v=20261112135907';

export const SUPABASE_URL = 'https://nqrnqpoklbcfncyxagcz.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_filQAlr3dYL3jmKZ3UlrGQ_H2FdZGUF';
const LS_SESSION = 'fc.session';
// Supabase demande un e-mail : l'identifiant est transformé en adresse interne, jamais utilisée pour écrire.
const DOMAIN = 'comptes.flashcards-tsi.fr';

export const usernameToEmail = (u) => u.trim().toLowerCase() + '@' + DOMAIN;
export const validUsername = (u) => /^[a-z0-9][a-z0-9._-]{2,29}$/i.test(u.trim());

export function readSession() {
  try { return JSON.parse(localStorage.getItem(LS_SESSION)) || null; } catch (e) { return null; }
}
function writeSession(s) {
  try { if (s) localStorage.setItem(LS_SESSION, JSON.stringify(s)); else localStorage.removeItem(LS_SESSION); } catch (e) { /* stockage plein */ }
}

async function call(method, path, { body, token, headers = {}, raw = false } = {}) {
  let res;
  try {
    res = await fetch(SUPABASE_URL + path, {
      method,
      cache: 'no-store',
      headers: {
        apikey: SUPABASE_KEY,
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : (body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array ? body : JSON.stringify(body)),
    });
  } catch (e) {
    throw new GitHubError(0, 'Pas de connexion au serveur.');
  }
  if (!res.ok) {
    let j = null;
    try { j = await res.json(); } catch (e) { /* corps vide */ }
    const msg = (j && (j.msg || j.message || j.error_description || j.error)) || 'Erreur serveur ' + res.status;
    const code = j && (j.code || j.error_code);
    // Conflit de version (put_doc) : même statut que GitHub, pour isConflict().
    if (code === '40001' || /conflit/.test(msg)) throw new GitHubError(409, 'Modifié ailleurs entre-temps.');
    const err = new GitHubError(res.status, msg);
    err.code = code;
    throw err;
  }
  if (raw) return res;
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------- Comptes ----------
function sessionFrom(d) {
  return { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in || 3600) * 1000, user: { id: d.user.id } };
}

export async function signUp(username, password, invite) {
  if (!validUsername(username)) throw new Error('Identifiant : 3 à 30 caractères (lettres, chiffres, point, tiret).');
  if (password.length < 8) throw new Error('Mot de passe : 8 caractères minimum.');
  if (!(await call('POST', '/rest/v1/rpc/check_invite', { body: { p_code: invite.trim() } }))) throw new Error('Code d\'invitation incorrect.');
  if (!(await call('POST', '/rest/v1/rpc/username_available', { body: { p_username: username.trim() } }))) throw new Error('Cet identifiant est déjà pris.');
  const d = await call('POST', '/auth/v1/signup', {
    body: { email: usernameToEmail(username), password, data: { username: username.trim().toLowerCase(), invite: invite.trim() } },
  });
  if (!d || !d.access_token) throw new Error('Compte créé, mais la connexion automatique a échoué : connecte-toi.');
  const s = sessionFrom(d);
  writeSession(s);
  return s;
}

export async function signIn(username, password) {
  try {
    const d = await call('POST', '/auth/v1/token?grant_type=password', { body: { email: usernameToEmail(username), password } });
    const s = sessionFrom(d);
    writeSession(s);
    return s;
  } catch (e) {
    if (e.status === 400) throw new Error('Identifiant ou mot de passe incorrect.');
    throw e;
  }
}

export async function signOut(store) {
  try { if (store) await call('POST', '/auth/v1/logout', { token: await store.token() }); } catch (e) { /* déjà déconnecté */ }
  writeSession(null);
}

export async function changePassword(store, password) {
  if (password.length < 8) throw new Error('Mot de passe : 8 caractères minimum.');
  await call('PUT', '/auth/v1/user', { token: await store.token(), body: { password } });
}

// ---------- Données du compte ----------
const isImage = (path) => path.startsWith('images/');
const mimeOf = (path) => (/\.pdf$/i.test(path) ? 'application/pdf' : /\.png$/i.test(path) ? 'image/png' : /\.jpe?g$/i.test(path) ? 'image/jpeg' : /\.webp$/i.test(path) ? 'image/webp' : /\.gif$/i.test(path) ? 'image/gif' : 'application/octet-stream');
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

export class SupaStore {
  constructor(session) {
    this.session = session;
    this.kind = 'supabase';
    this.refreshing = null;
  }

  get userId() { return this.session.user.id; }

  // Jeton d'accès valide (renouvelé une minute avant expiration).
  async token() {
    if (Date.now() < this.session.expires_at - 60000) return this.session.access_token;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const d = await call('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: this.session.refresh_token } });
          this.session = sessionFrom(d);
          writeSession(this.session);
        } catch (e) {
          if (e.status === 400 || e.status === 401) { writeSession(null); document.dispatchEvent(new Event('session-expired')); }
          throw e;
        } finally { this.refreshing = null; }
      })();
    }
    await this.refreshing;
    return this.session.access_token;
  }

  // Fonction de la base (RPC).
  async rpc(name, body = {}) {
    return call('POST', '/rest/v1/rpc/' + name, { token: await this.token(), body });
  }

  async profile() {
    const rows = await call('GET', '/rest/v1/profiles?select=username,features', { token: await this.token() });
    return rows && rows[0] ? rows[0] : null;
  }

  // Lit un document. Renvoie { text, sha } ou null.
  async getFile(_repo, path) {
    const rows = await call('GET', '/rest/v1/docs?select=content,version&path=eq.' + encodeURIComponent(path), { token: await this.token() });
    return rows && rows.length ? { text: rows[0].content, sha: String(rows[0].version) } : null;
  }

  // Écrit un document (texte) ou un fichier (base64) ; renvoie la nouvelle version.
  async putFile(_repo, path, content, sha, _message, isBase64 = false) {
    if (isBase64) {
      const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
      await call('POST', '/storage/v1/object/' + (isImage(path) ? 'images' : 'files') + '/' + this.userId + '/' + enc(path), {
        token: await this.token(), body: new Blob([bytes], { type: mimeOf(path) }), headers: { 'x-upsert': 'true', 'Content-Type': mimeOf(path) },
      });
      return 'f' + Date.now();
    }
    const v = await call('POST', '/rest/v1/rpc/put_doc', {
      token: await this.token(), body: { p_path: path, p_content: content, p_version: sha ? Number(sha) : null },
    });
    return String(v);
  }

  // Fichier binaire (PDF) : ArrayBuffer.
  async getBinary(_repo, path) {
    const res = await call('GET', '/storage/v1/object/authenticated/files/' + this.userId + '/' + enc(path), { token: await this.token(), raw: true });
    return res.arrayBuffer();
  }

  async deleteFile(_repo, path) {
    if (/\.json$/i.test(path)) {
      await call('DELETE', '/rest/v1/docs?path=eq.' + encodeURIComponent(path), { token: await this.token() });
    } else {
      await call('DELETE', '/storage/v1/object/' + (isImage(path) ? 'images' : 'files') + '/' + this.userId + '/' + enc(path), { token: await this.token() });
    }
  }

  // Adresse publique d'une image de carte.
  imageUrl(path) {
    return SUPABASE_URL + '/storage/v1/object/public/images/' + this.userId + '/' + enc(path);
  }
}
