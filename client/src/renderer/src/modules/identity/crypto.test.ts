import { describe, it, expect } from 'vitest';
import {
  generateUserSecret,
  encryptUserSecret,
  decryptUserSecret,
  deriveSaslPassword,
  generateRecoveryCode,
  normalizeRecoveryCode,
  wrapUserSecret,
  unwrapUserSecret,
  encryptCreds,
  decryptCreds,
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

describe('crypto.generateRecoveryCode / normalizeRecoveryCode', () => {
  it('formats as 8 dash-separated groups of 4 from an unambiguous alphabet', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9a-z]{4}(-[0-9a-z]{4}){7}$/);
    // Crockford-style: never emits i, l, o, or u.
    expect(code.replace(/-/g, '')).not.toMatch(/[ilou]/);
  });

  it('is different each call', () => {
    expect(generateRecoveryCode()).not.toBe(generateRecoveryCode());
  });

  it('normalizes dashes, spacing, case, and O/0 I/l/1 confusions', () => {
    expect(normalizeRecoveryCode('AB3D-EF5H')).toBe('ab3def5h');
    expect(normalizeRecoveryCode('  ab3d ef5h ')).toBe('ab3def5h');
    expect(normalizeRecoveryCode('aboi-lLOO')).toBe('ab011100'); // o→0, i/l→1
  });
});

describe('crypto.wrapUserSecret / unwrapUserSecret (recovery code)', () => {
  it('round-trips the same 32-byte secret', async () => {
    const secret = generateUserSecret();
    const code = generateRecoveryCode();
    const blob = await wrapUserSecret(secret, code, fastArgon);
    const out = await unwrapUserSecret(blob, code, fastArgon);
    expect(Array.from(out)).toEqual(Array.from(secret));
  });

  it('is forgiving about formatting on unlock (dashes/case stripped)', async () => {
    const secret = generateUserSecret();
    const code = generateRecoveryCode();
    const blob = await wrapUserSecret(secret, code, fastArgon);
    // Re-type without dashes and uppercased — should still unlock.
    const typed = code.replace(/-/g, '').toUpperCase();
    const out = await unwrapUserSecret(blob, typed, fastArgon);
    expect(Array.from(out)).toEqual(Array.from(secret));
  });

  it('fails with the wrong code', async () => {
    const secret = generateUserSecret();
    const blob = await wrapUserSecret(secret, generateRecoveryCode(), fastArgon);
    await expect(unwrapUserSecret(blob, generateRecoveryCode(), fastArgon)).rejects.toThrow();
  });

  it('password-wrap and recovery-wrap of the same secret both unlock it but differ', async () => {
    const secret = generateUserSecret();
    const code = generateRecoveryCode();
    const passwordBlob = await encryptUserSecret(secret, 'login-pw', fastArgon);
    const recoveryBlob = await wrapUserSecret(secret, code, fastArgon);
    expect(Array.from(passwordBlob)).not.toEqual(Array.from(recoveryBlob));
    expect(Array.from(await decryptUserSecret(passwordBlob, 'login-pw', fastArgon))).toEqual(Array.from(secret));
    expect(Array.from(await unwrapUserSecret(recoveryBlob, code, fastArgon))).toEqual(Array.from(secret));
  });
});

describe('crypto.encryptCreds / decryptCreds (NickServ sync envelope)', () => {
  it('round-trips password + accountName', async () => {
    const secret = generateUserSecret();
    const blob = await encryptCreds(secret, 'srv-1', { nickservPassword: 'hunter2', accountName: 'Nyan' });
    expect(await decryptCreds(secret, 'srv-1', blob)).toEqual({ nickservPassword: 'hunter2', accountName: 'Nyan' });
  });

  it('fails to decrypt under a different serverId (per-server key)', async () => {
    const secret = generateUserSecret();
    const blob = await encryptCreds(secret, 'srv-1', { nickservPassword: 'pw' });
    await expect(decryptCreds(secret, 'srv-2', blob)).rejects.toThrow();
  });

  it('fails to decrypt under a different user_secret', async () => {
    const blob = await encryptCreds(generateUserSecret(), 'srv-1', { nickservPassword: 'pw' });
    await expect(decryptCreds(generateUserSecret(), 'srv-1', blob)).rejects.toThrow();
  });

  it('produces different ciphertext each encrypt (random IV)', async () => {
    const secret = generateUserSecret();
    const a = await encryptCreds(secret, 'srv-1', { nickservPassword: 'pw' });
    const b = await encryptCreds(secret, 'srv-1', { nickservPassword: 'pw' });
    expect(a).not.toBe(b);
  });
});

describe('base64Encode/Decode', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 100]);
    const s = base64Encode(bytes);
    expect(Array.from(base64Decode(s))).toEqual(Array.from(bytes));
  });
});
