// Envoi de notifications Web Push sans dépendance (Node 18+).
// Chiffrement du message : RFC 8291 (aes128gcm). Authentification du serveur : VAPID (RFC 8292).
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// Clé privée VAPID au format JWK { kty, crv, x, y, d }.
function vapidHeader(endpoint, jwk, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(header + '.' + claims), { key, dsaEncoding: 'ieee-p1363' });
  const pub = Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
  return 'vapid t=' + header + '.' + claims + '.' + b64u(sig) + ', k=' + b64u(pub);
}

// Chiffre `payload` pour l'abonnement { keys: { p256dh, auth } }.
export function encrypt(sub, payload, salt = crypto.randomBytes(16), ecdh = null) {
  const uaPublic = fromB64u(sub.keys.p256dh);
  const auth = fromB64u(sub.keys.auth);
  const as = ecdh || crypto.createECDH('prime256v1');
  if (!ecdh) as.generateKeys();
  const asPublic = as.getPublicKey();
  const shared = as.computeSecret(uaPublic);
  const prkKey = hmac(auth, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Envoie une notification. Renvoie le code HTTP (201 = acceptée, 404/410 = abonnement expiré).
export async function sendPush(sub, payload, { jwk, subject, ttl = 12 * 3600, urgency = 'normal', topic } = {}) {
  const body = encrypt(sub, JSON.stringify(payload));
  const headers = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: vapidHeader(sub.endpoint, jwk, subject),
  };
  if (topic) headers.Topic = topic;
  const res = await fetch(sub.endpoint, { method: 'POST', headers, body });
  const text = res.ok ? '' : await res.text().catch(() => '');
  return { status: res.status, text };
}
