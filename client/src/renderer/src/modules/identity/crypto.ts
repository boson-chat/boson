import { argon2id } from '@noble/hashes/argon2.js';

// Encrypted user_secret blob format (binary, then base64 for transit):
//   bytes 0..15   — Argon2id salt (16 bytes)
//   bytes 16..27  — AES-GCM IV (12 bytes)
//   bytes 28..    — ciphertext concatenated with the 16-byte GCM auth tag
//                   (Web Crypto's AES-GCM encrypt() returns ciphertext||tag).
const SALT_LEN = 16;
const IV_LEN = 12;
const HEADER_LEN = SALT_LEN + IV_LEN;
const USER_SECRET_LEN = 32;

// Argon2id parameters — interactive profile from OWASP guidance, deliberately
// not configurable from the app so a downgrade can't sneak in via env.
// Tests should pass `argonOverride` to IdentityService instead of weakening
// these. Roughly ~200ms in modern browsers.
export const ARGON2_PARAMS = { t: 3, m: 65536, p: 1, dkLen: 32 } as const;

export interface ArgonFn {
  (password: string, salt: Uint8Array): Uint8Array; // returns 32-byte raw key
}

const defaultArgon: ArgonFn = (password, salt) =>
  argon2id(password, salt, ARGON2_PARAMS);

export function generateUserSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(USER_SECRET_LEN));
}

export async function encryptUserSecret(
  secret: Uint8Array,
  password: string,
  argon: ArgonFn = defaultArgon,
): Promise<Uint8Array> {
  if (secret.byteLength !== USER_SECRET_LEN) {
    throw new Error(`user_secret must be exactly ${USER_SECRET_LEN} bytes`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const kek = await importAesKey(argon(password, salt));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBuf(iv) }, kek, asBuf(secret)),
  );
  const out = new Uint8Array(HEADER_LEN + ciphertext.byteLength);
  out.set(salt, 0);
  out.set(iv, SALT_LEN);
  out.set(ciphertext, HEADER_LEN);
  return out;
}

export async function decryptUserSecret(
  blob: Uint8Array,
  password: string,
  argon: ArgonFn = defaultArgon,
): Promise<Uint8Array> {
  if (blob.byteLength < HEADER_LEN) {
    throw new Error('encrypted_user_secret: blob too short');
  }
  const salt = blob.slice(0, SALT_LEN);
  const iv = blob.slice(SALT_LEN, HEADER_LEN);
  const ciphertext = blob.slice(HEADER_LEN);
  const kek = await importAesKey(argon(password, salt));
  // AES-GCM decrypt throws on tag mismatch — that's our wrong-password signal.
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuf(iv) }, kek, asBuf(ciphertext)),
  );
  if (plain.byteLength !== USER_SECRET_LEN) {
    throw new Error('decrypted user_secret has unexpected length');
  }
  return plain;
}

// Per PRD: derived_password = HMAC-SHA256(user_secret, "irc-password" || server_id).
// Encoded URL-safe base64 so IRC SASL can carry it without escaping.
export async function deriveSaslPassword(
  userSecret: Uint8Array,
  serverId: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    asBuf(userSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const info = new TextEncoder().encode(`irc-password${serverId}`);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, asBuf(info)));
  return base64UrlEncode(sig);
}

// ----- Recovery code (second, independent wrap of user_secret) ---------------
//
// The recovery code lets a user who forgot their Boson login password (or who
// has lost their device keychain) still unlock the SAME user_secret. It wraps
// user_secret with the exact same Argon2id + AES-GCM envelope as the password
// wrap — just keyed by the (normalized) recovery code. Independent random salt
// ⇒ independent KEK; the server stores both blobs and can decrypt neither.

// Crockford base32, lowercase, omitting i/l/o/u so a code is unambiguous when
// written down or read aloud. 20 random bytes (160 bits) → exactly 32 chars.
const RECOVERY_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const RECOVERY_BYTES = 20;

// Generates a one-time recovery code, grouped 8×4 for legibility
// ("ab3d-ef5h-..."). Shown to the user once and NEVER persisted by us — only
// the wrap it produces is stored.
export function generateRecoveryCode(): string {
  const chars = base32Encode(crypto.getRandomValues(new Uint8Array(RECOVERY_BYTES)));
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += 4) groups.push(chars.slice(i, i + 4));
  return groups.join('-');
}

// Canonicalizes a user-typed code so the KDF input is stable regardless of
// dashes, spacing, case, or the classic O/0 and I/l/1 confusions. Both
// wrap and unwrap run inputs through this, so paste-back is forgiving.
export function normalizeRecoveryCode(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\s-]+/g, '')
    .replace(/o/g, '0')
    .replace(/[il]/g, '1');
}

// Wrap/unwrap user_secret under a recovery code. Thin, self-documenting
// aliases over the password envelope (same blob format) with normalization.
export function wrapUserSecret(
  secret: Uint8Array,
  recoveryCode: string,
  argon: ArgonFn = defaultArgon,
): Promise<Uint8Array> {
  return encryptUserSecret(secret, normalizeRecoveryCode(recoveryCode), argon);
}

export function unwrapUserSecret(
  blob: Uint8Array,
  recoveryCode: string,
  argon: ArgonFn = defaultArgon,
): Promise<Uint8Array> {
  return decryptUserSecret(blob, normalizeRecoveryCode(recoveryCode), argon);
}

// ----- NickServ credential envelope (E2E sync to server) ---------------------
//
// Per-server symmetric encryption of the IRC NickServ password. The key is
// derived from user_secret (never the login password directly), so the server
// stores only opaque ciphertext. Only the password + account nick are synced;
// session bookkeeping (status/email/pending) stays local.

export interface NickservCreds {
  nickservPassword: string;
  accountName?: string;
}

// credsKey(serverId) = HMAC-SHA256(user_secret, "nickserv-creds-v1" || serverId),
// imported as a non-extractable AES-256-GCM key. Domain-separated from the SASL
// derivation ("irc-password" || serverId) and versioned for clean rotation.
export async function deriveCredsKey(userSecret: Uint8Array, serverId: string): Promise<CryptoKey> {
  const hmacKey = await crypto.subtle.importKey(
    'raw', asBuf(userSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const info = new TextEncoder().encode(`nickserv-creds-v1${serverId}`);
  const raw = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, asBuf(info)));
  return crypto.subtle.importKey('raw', asBuf(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// Encrypts the per-server creds to base64(iv || ciphertext||tag). No salt — the
// key is HMAC-derived, not password-derived.
export async function encryptCreds(
  userSecret: Uint8Array,
  serverId: string,
  creds: NickservCreds,
): Promise<string> {
  const key = await deriveCredsKey(userSecret, serverId);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const plain = new TextEncoder().encode(JSON.stringify(creds));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBuf(iv) }, key, asBuf(plain)),
  );
  const out = new Uint8Array(IV_LEN + ct.byteLength);
  out.set(iv, 0);
  out.set(ct, IV_LEN);
  return base64Encode(out);
}

// Decrypts a blob from encryptCreds. Throws on tag mismatch (wrong key) or
// malformed plaintext — callers treat that as "skip this entry, keep local".
export async function decryptCreds(
  userSecret: Uint8Array,
  serverId: string,
  blobB64: string,
): Promise<NickservCreds> {
  const blob = base64Decode(blobB64);
  if (blob.byteLength < IV_LEN) throw new Error('nickserv creds: blob too short');
  const iv = blob.slice(0, IV_LEN);
  const ct = blob.slice(IV_LEN);
  const key = await deriveCredsKey(userSecret, serverId);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuf(iv) }, key, asBuf(ct)),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as NickservCreds;
  if (!parsed || typeof parsed.nickservPassword !== 'string') {
    throw new Error('nickserv creds: malformed plaintext');
  }
  return parsed;
}

// ----- base64 helpers --------------------------------------------------------

export function base64Encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function base64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Crockford-style base32 over RECOVERY_ALPHABET. Input lengths that are a
// multiple of 5 bits encode with no padding (20 bytes → 32 chars exactly).
function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      out += RECOVERY_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += RECOVERY_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', asBuf(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// TS 5.7+ types Uint8Array as Uint8Array<ArrayBufferLike>, which includes
// SharedArrayBuffer and isn't assignable to BufferSource. Web Crypto accepts
// any Uint8Array at runtime — this helper appeases the compiler without copying.
function asBuf(b: Uint8Array): BufferSource {
  return b as unknown as BufferSource;
}

// Zeroize secret material before dropping the reference. Best-effort —
// V8 GC may have copied the buffer, but this still beats leaving 32 bytes
// of plaintext sitting in the renderer heap.
export function zeroize(bytes: Uint8Array): void {
  bytes.fill(0);
}
