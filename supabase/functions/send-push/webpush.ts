// Web Push primitives on plain WebCrypto — no npm, runs on Deno (edge) and Node ≥ 20.
//
//   • RFC 8291 payload encryption (aes128gcm, ECDH P-256 + HKDF-SHA256)
//   • RFC 8292 VAPID (ES256 JWT, `Authorization: vapid t=…, k=…`)
//
// Pure functions only: nothing here reads env or touches the network except
// sendWebPush(), which takes everything as arguments. Unit-tested against the
// RFC 8291 Appendix A vector (see scripts/test-webpush.mjs in the scratchpad).

export type PushSubscriptionKeys = { endpoint: string; p256dh: string; auth: string };
export type VapidKeys = { publicKey: string; privateKey: string; subject: string }; // base64url raw 65 / raw 32

const te = new TextEncoder();

export function b64urlDecode(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Raw 65-byte uncompressed point → JWK (x, y); with `d` → private JWK.
function rawToJwk(pub: Uint8Array, d?: Uint8Array): JsonWebKey {
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('bad_p256_public_key');
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)) };
  if (d) { if (d.length !== 32) throw new Error('bad_p256_private_key'); jwk.d = b64urlEncode(d); }
  return jwk;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// RFC 8291 §3 + RFC 8188. Returns the complete aes128gcm body (header || ciphertext).
// `senderKeys`/`salt` are injectable ONLY so the RFC test vector can be replayed;
// production callers omit them and get a fresh ephemeral key + random salt.
export async function encryptPayload(
  plaintext: Uint8Array,
  receiver: { p256dh: string; auth: string },
  opts: { senderPrivateRaw?: Uint8Array; senderPublicRaw?: Uint8Array; salt?: Uint8Array } = {},
): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(receiver.p256dh);
  const authSecret = b64urlDecode(receiver.auth);
  if (authSecret.length !== 16) throw new Error('bad_auth_secret');

  // Sender (application server) ephemeral ECDH key.
  let asPrivate: CryptoKey; let asPublicRaw: Uint8Array;
  if (opts.senderPrivateRaw && opts.senderPublicRaw) {
    asPrivate = await crypto.subtle.importKey('jwk', rawToJwk(opts.senderPublicRaw, opts.senderPrivateRaw), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    asPublicRaw = opts.senderPublicRaw;
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPrivate = kp.privateKey;
    asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  }
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));

  // IKM = HKDF(salt=auth_secret, ecdh_secret, "WebPush: info\0" || ua_public || as_public, 32)
  const keyInfo = concat(te.encode('WebPush: info\0'), uaPublic, asPublicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error('bad_salt');
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);

  // Single record: plaintext || 0x02 (last-record delimiter), no extra padding.
  const padded = concat(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded));

  // Header: salt(16) || rs(4, BE) || idlen(1) || keyid(as_public, 65)
  const rs = 4096;
  const header = concat(salt, new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]), new Uint8Array([asPublicRaw.length]), asPublicRaw);
  return concat(header, ciphertext);
}

// RFC 8292: ES256 JWT for the push service origin, signed with the raw VAPID private key.
export async function vapidAuthorization(endpoint: string, vapid: VapidKeys, ttlSeconds = 12 * 3600): Promise<string> {
  const aud = new URL(endpoint).origin;
  const pub = b64urlDecode(vapid.publicKey);
  const prv = b64urlDecode(vapid.privateKey);
  const key = await crypto.subtle.importKey('jwk', rawToJwk(pub, prv), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = b64urlEncode(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + ttlSeconds, sub: vapid.subject })));
  const input = `${header}.${claims}`;
  // WebCrypto ECDSA returns the raw r||s (64 bytes) — exactly the JWS form.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(input)));
  return `vapid t=${input}.${b64urlEncode(sig)}, k=${vapid.publicKey}`;
}

export type PushResult = { ok: boolean; status: number; gone: boolean; detail?: string };

// Encrypt + sign + POST one message to one subscription.
// `gone` = 404/410 → the subscription is dead and should be deleted.
export async function sendWebPush(
  sub: PushSubscriptionKeys,
  payload: string | Uint8Array,
  vapid: VapidKeys,
  opts: { ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; topic?: string } = {},
): Promise<PushResult> {
  const plaintext = typeof payload === 'string' ? te.encode(payload) : payload;
  if (plaintext.length > 3993) throw new Error('payload_too_large'); // 4096 − header(86) − tag(16) − delimiter(1)
  const body = await encryptPayload(plaintext, sub);
  const headers: Record<string, string> = {
    Authorization: await vapidAuthorization(sub.endpoint, vapid),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(opts.ttl ?? 24 * 3600),
    Urgency: opts.urgency ?? 'normal',
  };
  if (opts.topic) headers.Topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  try {
    const res = await fetch(sub.endpoint, { method: 'POST', headers, body });
    const ok = res.status >= 200 && res.status < 300;
    let detail = '';
    if (!ok) { try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ } }
    return { ok, status: res.status, gone: res.status === 404 || res.status === 410, detail };
  } catch (e) {
    return { ok: false, status: 0, gone: false, detail: String((e as Error).message).slice(0, 200) };
  }
}
