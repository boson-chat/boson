import { describe, it, expect } from 'vitest';
import { argon2id as nobleArgon2id } from '@noble/hashes/argon2.js';
import { argon2idInline, argon2idKey } from './argon2';
import { ARGON2_PARAMS, decryptUserSecret, encryptUserSecret, generateUserSecret } from './crypto';

// Identity blobs already stored by users were wrapped with @noble/hashes'
// Argon2id. The WASM implementation must produce byte-identical keys or those
// users could never unlock again.
describe('argon2 (hash-wasm) compatibility with the previous @noble/hashes KDF', () => {
  const cheap = { t: 2, m: 256, p: 1, dkLen: 32 };

  it('derives the same key as @noble/hashes for the same inputs', async () => {
    const cases: Array<[string, Uint8Array]> = [
      ['correct horse battery staple', new Uint8Array(16).fill(7)],
      ['pässwörd ✓ unicode', Uint8Array.from({ length: 16 }, (_, i) => i * 13)],
      ['', new Uint8Array(16)],
    ];
    for (const [password, salt] of cases) {
      const expected = nobleArgon2id(password, salt, cheap);
      expect(await argon2idInline(password, salt, cheap)).toEqual(expected);
      // No Worker in the test env: argon2idKey falls back to inline.
      expect(await argon2idKey(password, salt, cheap)).toEqual(expected);
    }
  });

  it('matches @noble/hashes at the production parameters', async () => {
    const salt = new Uint8Array(16);
    const expected = nobleArgon2id('pw-HLUuG7mKj3I3', salt, ARGON2_PARAMS);
    expect(await argon2idInline('pw-HLUuG7mKj3I3', salt, ARGON2_PARAMS)).toEqual(expected);
  }, 60_000);

  it('a blob wrapped with the old KDF decrypts with the new default', async () => {
    const secret = generateUserSecret();
    const nobleKdf = (password: string, salt: Uint8Array) => nobleArgon2id(password, salt, ARGON2_PARAMS);
    const blob = await encryptUserSecret(secret, 'old-password', nobleKdf);
    expect(await decryptUserSecret(blob, 'old-password')).toEqual(secret);
    await expect(decryptUserSecret(blob, 'wrong-password')).rejects.toThrow();
  }, 60_000);
});
