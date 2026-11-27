import { describe, expect, it } from 'vitest';
import { DENIED_REASON, DESKTOP_REASON, NO_RELAY_REASON, NO_WEBPUSH_REASON, pushStatus, shouldRegister, type PushFacts } from './availability';

const ready: PushFacts = {
  platform: 'web', boson: true, viaBouncer: false, signedIn: true, cap: true, vapid: 'BKEY',
  permission: 'granted', off: false, registration: 'idle',
};

describe('pushStatus', () => {
  it('plain IRC and bouncers get no row', () => {
    expect(pushStatus({ ...ready, boson: false }).state).toBe('hidden');
    expect(pushStatus({ ...ready, viaBouncer: true }).state).toBe('hidden');
  });
  it('guests are asked to sign in', () => {
    expect(pushStatus({ ...ready, signedIn: false })).toEqual({ state: 'sign-in' });
  });
  it('says why it is unavailable', () => {
    expect(pushStatus({ ...ready, platform: null })).toEqual({ state: 'unavailable', reason: DESKTOP_REASON });
    expect(pushStatus({ ...ready, cap: false })).toEqual({ state: 'unavailable', reason: NO_WEBPUSH_REASON });
    expect(pushStatus({ ...ready, vapid: '' })).toEqual({ state: 'unavailable', reason: NO_WEBPUSH_REASON });
    expect(pushStatus({ ...ready, platform: 'ios', relay: '' })).toEqual({ state: 'unavailable', reason: NO_RELAY_REASON });
    expect(pushStatus({ ...ready, permission: 'denied' })).toEqual({ state: 'unavailable', reason: DENIED_REASON });
    expect(pushStatus({ ...ready, unsupported: 'Old browser' })).toEqual({ state: 'unavailable', reason: 'Old browser' });
    expect(pushStatus({ ...ready, registration: 'failed', error: 'Nope' })).toEqual({ state: 'unavailable', reason: 'Nope' });
  });
  it('the web needs no relay', () => {
    expect(pushStatus({ ...ready, relay: '' }).state).toBe('pending');
  });
  it('off, waiting for permission, pending, on', () => {
    expect(pushStatus({ ...ready, off: true })).toEqual({ state: 'off' });
    expect(pushStatus({ ...ready, permission: 'default' })).toEqual({ state: 'off', needsPermission: true });
    expect(pushStatus(ready)).toEqual({ state: 'pending' });
    expect(pushStatus({ ...ready, registration: 'ok' })).toEqual({ state: 'on' });
  });
});

describe('shouldRegister', () => {
  it('only with everything known and allowed', () => {
    expect(shouldRegister(ready)).toBe(true);
    expect(shouldRegister({ ...ready, cap: null })).toBe(false);
    expect(shouldRegister({ ...ready, vapid: null })).toBe(false);
    expect(shouldRegister({ ...ready, signedIn: false })).toBe(false);
    expect(shouldRegister({ ...ready, off: true })).toBe(false);
    expect(shouldRegister({ ...ready, permission: 'default' })).toBe(false);
    expect(shouldRegister({ ...ready, platform: 'android' })).toBe(false);
    expect(shouldRegister({ ...ready, platform: 'android', relay: 'https://push.boson.chat' })).toBe(true);
  });
});
