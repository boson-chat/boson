import { describe, it, expect } from 'vitest';
import { detectServicesFramework, isServiceSender } from './services';

describe('isServiceSender', () => {
  it.each([
    'NickServ', 'nickserv', 'ChanServ', 'OperServ', 'MemoServ',
    'BotServ', 'HostServ', 'SaslServ', 'global',
  ])('recognises %s as a service', (nick) => {
    expect(isServiceSender(nick)).toBe(true);
  });

  it('recognises server-hostname sender (contains a dot)', () => {
    expect(isServiceSender('hub.example.org')).toBe(true);
  });

  it('rejects ordinary nicks', () => {
    expect(isServiceSender('alice')).toBe(false);
    expect(isServiceSender('Bob_42')).toBe(false);
  });

  it('treats an empty sender as server-side (anonymous notice)', () => {
    expect(isServiceSender('')).toBe(true);
  });
});

describe('detectServicesFramework', () => {
  it('classifies Atheme by its name in the banner', () => {
    expect(detectServicesFramework(
      'This nickname is registered. atheme.org for help.',
    )).toBe('atheme');
    expect(detectServicesFramework('atheme-7.2.12')).toBe('atheme');
    expect(detectServicesFramework('Powered by Atheme IRC Services')).toBe('atheme');
  });

  it('classifies Anope by its versioned signature or "Anope IRC Services"', () => {
    expect(detectServicesFramework('Anope-2.0.10 — see /msg NickServ HELP')).toBe('anope');
    expect(detectServicesFramework('Anope IRC Services version 2.0')).toBe('anope');
  });

  it('returns null when neither signature is present', () => {
    expect(detectServicesFramework('Welcome to the network!')).toBeNull();
    expect(detectServicesFramework('This nickname is registered.')).toBeNull();
  });

  it('uses word-boundary matching — substrings within longer words do not match', () => {
    // Guard against false positives like "panopent" / "atheme-like".
    expect(detectServicesFramework('panopent and friends')).toBeNull();
    expect(detectServicesFramework('athemeoid behaviour')).toBeNull();
  });

  it('accepts the bare word "Anope" anywhere in a service banner', () => {
    // Service contexts only — `detectServicesFramework` is only called
    // from `isServiceSender` branches, so a bare "Anope" inside a real
    // service NOTICE is almost certainly the package name.
    expect(detectServicesFramework('Welcome — Anope')).toBe('anope');
  });

  it('returns null for empty input', () => {
    expect(detectServicesFramework('')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(detectServicesFramework('ATHEME version 7')).toBe('atheme');
    expect(detectServicesFramework('anope ircd services')).toBe('anope');
  });
});
