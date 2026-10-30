// Accès à l'API GitHub (lecture et écriture de fichiers dans un dépôt).
// Le jeton reste dans le navigateur de l'utilisateur et n'est envoyé qu'à api.github.com.

const API = 'https://api.github.com';

export function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export class GitHub {
  constructor(token) {
    this.token = token;
  }

  async request(method, path, body) {
    let res;
    try {
      res = await fetch(API + path, {
        method,
        cache: 'no-store',
        headers: {
          Authorization: 'Bearer ' + this.token,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new GitHubError(0, 'Pas de connexion à GitHub.');
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch (e) { /* corps vide */ }
      throw new GitHubError(res.status, detail || 'Erreur GitHub ' + res.status);
    }
    return res.status === 204 ? null : res.json();
  }

  // Vérifie l'accès à un dépôt. Renvoie { private, canWrite }.
  async checkRepo(repo) {
    const data = await this.request('GET', '/repos/' + repo);
    return { private: data.private, canWrite: !!(data.permissions && data.permissions.push) };
  }

  // Lit un fichier texte. Renvoie { text, sha } ou null s'il n'existe pas.
  async getFile(repo, path) {
    try {
      const data = await this.request('GET', '/repos/' + repo + '/contents/' + encodePath(path));
      if (data.content === undefined || data.encoding !== 'base64' || (data.content === '' && data.size > 0)) {
        // Fichier de plus de 1 Mo : on passe par l'API des blobs.
        const blob = await this.request('GET', '/repos/' + repo + '/git/blobs/' + data.sha);
        return { text: base64ToUtf8(blob.content), sha: data.sha };
      }
      return { text: base64ToUtf8(data.content), sha: data.sha };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  // Lit un fichier binaire (PDF…) en entier. Renvoie un ArrayBuffer.
  async getBinary(repo, path) {
    let res;
    try {
      res = await fetch(API + '/repos/' + repo + '/contents/' + encodePath(path), {
        cache: 'no-store',
        headers: {
          Authorization: 'Bearer ' + this.token,
          Accept: 'application/vnd.github.raw+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch (e) {
      throw new GitHubError(0, 'Pas de connexion à GitHub.');
    }
    if (!res.ok) throw new GitHubError(res.status, res.status === 404 ? 'Fichier introuvable sur GitHub.' : 'Erreur GitHub ' + res.status);
    return res.arrayBuffer();
  }

  // Supprime un fichier (sha requis).
  async deleteFile(repo, path, sha, message) {
    return this.request('DELETE', '/repos/' + repo + '/contents/' + encodePath(path), { message, sha });
  }

  // Crée ou remplace un fichier. `content` est du texte, sauf si isBase64 est vrai.
  // Renvoie le nouveau sha du fichier.
  async putFile(repo, path, content, sha, message, isBase64 = false) {
    const body = {
      message,
      content: isBase64 ? content : utf8ToBase64(content),
      ...(sha ? { sha } : {}),
    };
    const data = await this.request('PUT', '/repos/' + repo + '/contents/' + encodePath(path), body);
    return data.content.sha;
  }
}

// Un conflit d'écriture : le fichier a été modifié ailleurs depuis la dernière lecture.
export function isConflict(e) {
  return e instanceof GitHubError && (e.status === 409 || e.status === 422);
}
