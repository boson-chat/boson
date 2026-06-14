import { describe, it, expect } from 'vitest';
import { encryptBouncer, decryptBouncer, type BouncerProfileSecret } from './crypto';

const secret = () => {
  const s = new Uint8Array(32);
  for (let i = 0; i < 32; i++) s[i] = i + 1;
  return s;
};

const profile: BouncerProfileSecret = {
  enabled: true,
  host: 'znc.example.com',
  port: 6697,
  tls: true,
  tlsInsecure: true,
  username: 'me',
  password: 'hunter2',
};

describe('bouncer profile envelope', () => {
  it('round-trips with the same user_secret', async () => {
    const blob = await encryptBouncer(secret(), profile);
    expect(typeof blob).toBe('string');
    const back = await decryptBouncer(secret(), blob);
    expect(back).toEqual(profile);
  });

  it('produces a fresh IV each time (different ciphertext, same plaintext)', async () => {
    const a = await encryptBouncer(secret(), profile);
    const b = await encryptBouncer(secret(), profile);
    expect(a).not.toBe(b);
  });

  it('throws on the wrong key', async () => {
    const blob = await encryptBouncer(secret(), profile);
    const wrong = new Uint8Array(32).fill(9);
    await expect(decryptBouncer(wrong, blob)).rejects.toThrow();
  });

  it('throws on a malformed blob', async () => {
    await expect(decryptBouncer(secret(), 'not-base64-or-too-short')).rejects.toThrow();
  });
});
