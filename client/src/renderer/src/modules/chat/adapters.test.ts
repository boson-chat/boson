import { describe, it, expect } from 'vitest';
import { AnopeAdapter, AthemeAdapter, ErgoAdapter, getAdapter } from './adapters';

// Post-migration the adapter surface has shrunk to a single
// operation — INFO. All other commands (REGISTER / IDENTIFY /
// CONFIRM / DROP / RESEND) live on their respective AccountService
// impls now and are covered by per-operation test files in this
// directory (account-service-{drop,identify,register,confirm,resend}.test.ts).

describe('AnopeAdapter.buildInfo', () => {
  it('formats INFO with the account name', () => {
    const a = new AnopeAdapter();
    expect(a.buildInfo('Nyan')).toBe('/msg NickServ INFO Nyan');
  });

  it('reports id = anope', () => {
    expect(new AnopeAdapter().id).toBe('anope');
  });
});

describe('AthemeAdapter.buildInfo', () => {
  it('formats INFO with the account name', () => {
    expect(new AthemeAdapter().buildInfo('alice')).toBe('/msg NickServ INFO alice');
  });

  it('reports id = atheme', () => {
    expect(new AthemeAdapter().id).toBe('atheme');
  });
});

describe('ErgoAdapter.buildInfo', () => {
  it('formats INFO with the account name', () => {
    expect(new ErgoAdapter().buildInfo('alice')).toBe('/msg NickServ INFO alice');
  });

  it('reports id = ergo', () => {
    expect(new ErgoAdapter().id).toBe('ergo');
  });
});

describe('getAdapter selector', () => {
  it('returns AnopeAdapter for "anope"', () => {
    expect(getAdapter('anope')).toBeInstanceOf(AnopeAdapter);
  });

  it('returns AthemeAdapter for "atheme"', () => {
    expect(getAdapter('atheme')).toBeInstanceOf(AthemeAdapter);
  });

  it('returns ErgoAdapter for "ergo"', () => {
    expect(getAdapter('ergo')).toBeInstanceOf(ErgoAdapter);
  });

  it('falls back to Anope for unknown / null / undefined', () => {
    // Mirrors getAdapter()'s default policy — Anope is the most
    // common shape on UnrealIRCd-style networks where the detector
    // hasn't yet classified.
    expect(getAdapter('unknown')).toBeInstanceOf(AnopeAdapter);
    expect(getAdapter(null)).toBeInstanceOf(AnopeAdapter);
    expect(getAdapter(undefined)).toBeInstanceOf(AnopeAdapter);
  });
});
