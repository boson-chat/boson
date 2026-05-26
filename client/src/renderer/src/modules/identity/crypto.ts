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
