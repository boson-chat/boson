import { describe, it, expect } from 'vitest';
import {
  generateUserSecret,
  encryptUserSecret,
  decryptUserSecret,
  deriveSaslPassword,
  base64Encode,
  base64Decode,
  type ArgonFn,
} from './crypto';

// Fast deterministic KDF for tests: salt|password truncated/padded to 32 bytes.
// Lets us round-trip encrypt/decrypt without paying ~200ms per Argon2 call.
const fastArgon: ArgonFn = (password, salt) => {
  const enc = new TextEncoder().encode(password);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = (salt[i % salt.byteLength] ?? 0) ^ (enc[i % Math.max(enc.byteLength, 1)] ?? 0);
  }
  return out;
};

describe('crypto.generateUserSecret', () => {
  it('returns 32 bytes', () => {
    expect(generateUserSecret().byteLength).toBe(32);
  });
  it('returns different bytes each call', () => {
    const a = generateUserSecret();
    const b = generateUserSecret();
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});

describe('crypto.encryptUserSecret / decryptUserSecret', () => {
  it('round-trips with the right password', async () => {
    const secret = generateUserSecret();
    const blob = await encryptUserSecret(secret, 'hunter2', fastArgon);
    const out = await decryptUserSecret(blob, 'hunter2', fastArgon);
    expect(Array.from(out)).toEqual(Array.from(secret));
  });

  it('fails to decrypt with the wrong password', async () => {
    const secret = generateUserSecret();
    const blob = await encryptUserSecret(secret, 'hunter2', fastArgon);
    await expect(decryptUserSecret(blob, 'wrong', fastArgon)).rejects.toThrow();
  });

  it('rejects ciphertext shorter than the header', async () => {
    const tiny = new Uint8Array(10);
    await expect(decryptUserSecret(tiny, 'hunter2', fastArgon)).rejects.toThrow(/too short/);
  });

  it('produces different ciphertext each encrypt (random salt+IV)', async () => {
    const secret = generateUserSecret();
    const a = await encryptUserSecret(secret, 'hunter2', fastArgon);
    const b = await encryptUserSecret(secret, 'hunter2', fastArgon);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('rejects encrypting a non-32-byte secret', async () => {
    const tooShort = new Uint8Array(16);
    await expect(encryptUserSecret(tooShort, 'hunter2', fastArgon)).rejects.toThrow(/32 bytes/);
  });
});

describe('crypto.deriveSaslPassword', () => {
  it('is deterministic for the same secret and serverId', async () => {
    const secret = generateUserSecret();
    const a = await deriveSaslPassword(secret, 'server-id-1');
    const b = await deriveSaslPassword(secret, 'server-id-1');
    expect(a).toBe(b);
  });

  it('produces a different password for different serverIds', async () => {
    const secret = generateUserSecret();
    const a = await deriveSaslPassword(secret, 'server-id-1');
    const b = await deriveSaslPassword(secret, 'server-id-2');
    expect(a).not.toBe(b);
  });

  it('produces a different password for different secrets', async () => {
    const secretA = generateUserSecret();
    const secretB = generateUserSecret();
    const a = await deriveSaslPassword(secretA, 'server-id-1');
    const b = await deriveSaslPassword(secretB, 'server-id-1');
    expect(a).not.toBe(b);
  });

  it('output is URL-safe base64 (no +, /, or padding)', async () => {
    const secret = generateUserSecret();
    const p = await deriveSaslPassword(secret, 'sid');
    expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('base64Encode/Decode', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 100]);
    const s = base64Encode(bytes);
    expect(Array.from(base64Decode(s))).toEqual(Array.from(bytes));
  });
});
