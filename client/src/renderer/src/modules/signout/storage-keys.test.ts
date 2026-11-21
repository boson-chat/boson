import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_KEYS, DEVICE_KEYS, NOT_KEYS, matches, wipeAccountStorage } from './storage-keys';
import { InMemorySecureStorage, type SecureStorage } from '../../shared/secure-storage';

const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '__integration__' || name === 'gen') continue;
      out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

// Every 'boson:…' / 'boson.…' string literal outside comments and tests.
function keyLiterals(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles(SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (/^\s*\*/.test(code)) return;
      for (const m of code.matchAll(/['"`](boson[:.][A-Za-z0-9:._-]*)/g)) {
        if (!found.has(m[1]!)) found.set(m[1]!, `${relative(SRC, file)}:${i + 1}`);
      }
    });
  }
  return found;
}

const classified = (lit: string): boolean =>
  NOT_KEYS.includes(lit) ||
  [...ACCOUNT_KEYS.local, ...ACCOUNT_KEYS.secure, ...DEVICE_KEYS.local, ...DEVICE_KEYS.secure]
    .some((k) => k === lit || ((k.endsWith(':') || k.endsWith('.')) && lit.startsWith(k)));

class MemLocal {
  private m = new Map<string, string>();
  get length(): number { return this.m.size; }
  key(i: number): string | null { return Array.from(this.m.keys())[i] ?? null; }
  getItem(k: string): string | null { return this.m.get(k) ?? null; }
  setItem(k: string, v: string): void { this.m.set(k, v); }
  removeItem(k: string): void { this.m.delete(k); }
  keys(): string[] { return Array.from(this.m.keys()).sort(); }
}

describe('sign-out storage keys', () => {
  it('every storage key in the source is either wiped on sign-out or kept as a device preference', () => {
    const lits = keyLiterals();
    // The scan finds the stores it should (guards the scan itself).
    expect(lits.has('boson:session:v2')).toBe(true);
    expect(lits.has('boson:theme:v1')).toBe(true);
    const unknown = [...lits].filter(([lit]) => !classified(lit)).map(([lit, at]) => `${lit} (${at})`);
    expect(unknown, 'classify these in modules/signout/storage-keys.ts').toEqual([]);
  });

  it('no key is both personal and a device preference', () => {
    for (const k of DEVICE_KEYS.local) expect(matches(k, ACCOUNT_KEYS.local), k).toBe(false);
  });

  it('wipes the account keys from localStorage and the secure store, keeping device preferences', async () => {
    const local = new MemLocal();
    for (const k of [
      'boson:session:v2', 'boson:local-servers:v1', 'boson:directories:v1', 'boson:guest:v1', 'boson.memos.usr_a',
      'boson:notify-feed:v1:usr_a', 'boson.voice.guestId:https://auth.x', 'boson.netauth.known', 'boson.services-creds.libera',
      'boson:theme:v1', 'boson:voice:v1', 'boson:panel-sizes:v1', 'boson:notifications:v1', 'other-app',
    ]) local.setItem(k, '1');
    const secure = new InMemorySecureStorage();
    for (const k of ['boson.auth.session', 'boson.identity.usr_a', 'boson.identity.usr_b', 'boson.netauth.session:https://auth.x',
      'boson.bouncer.v1', 'boson.services-creds.v1', 'boson.nickserv-sync.meta', 'boson.bouncer-sync.meta']) await secure.set(k, 'v');
    await wipeAccountStorage({ userId: 'usr_a', guest: false }, secure, local);
    expect(local.keys()).toEqual(['boson:notifications:v1', 'boson:panel-sizes:v1', 'boson:theme:v1', 'boson:voice:v1', 'other-app']);
    // Every user's identity on this device goes, not just the one signing out.
    expect(secure.keys()).toEqual([]);
  });

  it('without prefix removal (an older shell), removes the keys it can name', async () => {
    const inner = new InMemorySecureStorage();
    const secure: SecureStorage = {
      isAvailable: () => inner.isAvailable(), get: (k) => inner.get(k), set: (k, v) => inner.set(k, v), remove: (k) => inner.remove(k),
    };
    for (const k of ['boson.identity.usr_a', 'boson.identity.usr_b', 'boson.netauth.session:https://auth.x', 'boson.auth.session']) await inner.set(k, 'v');
    await wipeAccountStorage({ userId: 'usr_a', guest: false }, secure, null, ['https://auth.x']);
    expect(inner.keys()).toEqual(['boson.identity.usr_b']);
  });

  it('reports keys it could not remove, after trying the rest', async () => {
    const inner = new InMemorySecureStorage();
    await inner.set('boson.bouncer.v1', 'v');
    const secure: SecureStorage = {
      isAvailable: async () => true, get: (k) => inner.get(k), set: (k, v) => inner.set(k, v),
      remove: async (k) => { if (k === 'boson.auth.session') throw new Error('locked'); await inner.remove(k); },
      removePrefix: (p) => inner.removePrefix(p),
    };
    await expect(wipeAccountStorage({ userId: 'u', guest: false }, secure, null)).rejects.toThrow(/1 key/);
    expect(inner.keys()).toEqual([]);
  });
});
