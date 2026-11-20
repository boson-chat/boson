import { describe, it, expect, beforeEach } from 'vitest';
import {
  getNotificationSettings, setNotificationSettings,
  DEFAULT_NOTIFICATION_SETTINGS, __resetNotificationSettingsCache,
} from './notifications.store';

beforeEach(() => {
  localStorage.clear();
  __resetNotificationSettingsCache();
});

describe('notifications.store', () => {
  it('defaults to enabled, mentions + DMs on, all-messages off', () => {
    expect(getNotificationSettings()).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(DEFAULT_NOTIFICATION_SETTINGS.mentions).toBe(true);
    expect(DEFAULT_NOTIFICATION_SETTINGS.allMessages).toBe(false);
  });

  it('persists a patch across a reload and keeps other fields', () => {
    setNotificationSettings({ allMessages: true, sound: false });
    __resetNotificationSettingsCache();
    const s = getNotificationSettings();
    expect(s.allMessages).toBe(true);
    expect(s.sound).toBe(false);
    expect(s.mentions).toBe(true);
  });
});

describe('notification settings: toasts, friends, calls and incoming calls', () => {
  it('defaults: toasts, friends and calls on; incoming calls full screen on phones, a banner on desktop', async () => {
    const m = await import('./notifications.store');
    localStorage.clear();
    m.__resetNotificationSettingsCache();
    const s = m.getNotificationSettings();
    expect(s).toMatchObject({ inApp: true, friends: true, calls: true });
    expect(m.incomingCallStyle(true, s)).toBe('full');
    expect(m.incomingCallStyle(false, s)).toBe('banner');
    m.setNotificationSettings({ incomingCalls: 'banner' });
    m.__resetNotificationSettingsCache();
    expect(m.incomingCallStyle(true)).toBe('banner');
  });

  it('per channel: All / Mentions / Nothing, defaulting to Mentions for channels and All for DMs', async () => {
    const m = await import('./notifications.store');
    localStorage.clear();
    m.__resetNotificationSettingsCache();
    expect(m.getChannelLevel('s1', '#dev')).toBe('mentions');
    expect(m.getChannelLevel('s1', 'mira')).toBe('all');
    m.setChannelLevel('s1', '#Dev', 'all');
    m.setChannelLevel('s1', 'mira', 'nothing');
    m.__resetNotificationSettingsCache();
    expect(m.getChannelLevel('s1', '#dev')).toBe('all');
    expect(m.getChannelLevel('s2', '#dev')).toBe('mentions');
    expect(m.getChannelLevel('s1', 'mira')).toBe('nothing');
  });
});
