import { describe, it, expect } from 'vitest';
import { classifyUpdaterError } from './auto-update';

describe('classifyUpdaterError', () => {
  it('flags a 404 on latest.yml as transient (release-asset race window)', () => {
    // The exact HttpError message electron-updater throws when the
    // GitHub Release stub exists but installers haven't uploaded yet.
    const err = new Error(
      "Cannot find latest.yml in the latest release artifacts (https://github.com/x/y/releases/download/v1.0.0/latest.yml): HttpError: 404 ...",
    );
    const verdict = classifyUpdaterError(err);
    expect(verdict.kind).toBe('transient');
    if (verdict.kind === 'transient') {
      expect(verdict.reason).toBe('release-metadata-not-yet-uploaded');
    }
  });

  it('flags latest-mac.yml / latest-linux.yml the same way', () => {
    for (const file of ['latest-mac.yml', 'latest-linux.yml']) {
      const verdict = classifyUpdaterError(new Error(`Cannot find ${file}: 404`));
      expect(verdict.kind).toBe('transient');
    }
  });

  it('flags common network errors as transient', () => {
    for (const msg of [
      'getaddrinfo ENOTFOUND github.com',
      'connect ECONNREFUSED 140.82.121.4:443',
      'socket hang up ECONNRESET',
      'request timed out: ETIMEDOUT',
      'EAI_AGAIN api.github.com',
      'net::ERR_INTERNET_DISCONNECTED',
    ]) {
      const verdict = classifyUpdaterError(new Error(msg));
      expect(verdict.kind, msg).toBe('transient');
    }
  });

  it('returns permanent + a short single-line summary for unknown errors', () => {
    const err = new Error(
      'Signature verification failed\n  at lib/foo.js:42\n  at lib/bar.js:88',
    );
    const verdict = classifyUpdaterError(err);
    expect(verdict.kind).toBe('permanent');
    if (verdict.kind === 'permanent') {
      // First line only — never include the stack.
      expect(verdict.userMessage).toBe('Signature verification failed');
      expect(verdict.userMessage).not.toContain('lib/foo.js');
    }
  });

  it('caps a long single-line message at 140 chars', () => {
    const long = 'x'.repeat(500);
    const verdict = classifyUpdaterError(new Error(long));
    expect(verdict.kind).toBe('permanent');
    if (verdict.kind === 'permanent') {
      expect(verdict.userMessage.length).toBeLessThanOrEqual(140);
    }
  });

  it('handles non-Error values (string thrown, undefined)', () => {
    expect(classifyUpdaterError('some-error-string').kind).toBe('permanent');
    expect(classifyUpdaterError(null).kind).toBe('permanent');
    expect(classifyUpdaterError(undefined).kind).toBe('permanent');
  });

  it('does NOT flag an unrelated 404 as the release-asset race', () => {
    // A 404 that isn't on latest*.yml should still surface — could be
    // a misconfigured publish target, which the user does need to know.
    const err = new Error('GET /api/something 404 Not Found');
    const verdict = classifyUpdaterError(err);
    expect(verdict.kind).toBe('permanent');
  });
});
