import { describe, it, expect } from 'vitest';
import { channelPolicyFromConfig } from './policy';

describe('channelPolicyFromConfig', () => {
  it('no settings → no policy (older auth service)', () => {
    expect(channelPolicyFromConfig({ sso_providers: [] })).toBeNull();
    expect(channelPolicyFromConfig(null)).toBeNull();
  });
  it('auto-registration defaults on when the expiry setting is present', () => {
    expect(channelPolicyFromConfig({ channel_expiry_days: 0 })).toEqual({ autoRegister: true, expiryDays: 0 });
  });
  it('reads both settings', () => {
    expect(channelPolicyFromConfig({ channel_auto_register: false, channel_expiry_days: 30 })).toEqual({ autoRegister: false, expiryDays: 30 });
  });
  it('ignores nonsense expiry values', () => {
    expect(channelPolicyFromConfig({ channel_auto_register: true, channel_expiry_days: -4 })?.expiryDays).toBe(0);
    expect(channelPolicyFromConfig({ channel_auto_register: true, channel_expiry_days: 'x' as never })?.expiryDays).toBe(0);
    expect(channelPolicyFromConfig({ channel_auto_register: true, channel_expiry_days: 14.7 })?.expiryDays).toBe(14);
  });
});
