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

describe('notification levels: server, then channel', () => {
  it('a server sets what its channels and DMs default to; others keep the defaults', async () => {
    const m = await import('./notifications.store');
    expect(m.getServerLevels('s1')).toEqual({ channels: 'mentions', dms: 'all' });
    m.setServerLevels('s1', { channels: 'all' });
    m.setServerLevels('s1', { dms: 'nothing' });
    m.__resetNotificationSettingsCache();
    expect(m.getServerLevels('s1')).toEqual({ channels: 'all', dms: 'nothing' });
    expect(m.getChannelLevel('s1', '#dev')).toBe('all');
    expect(m.getChannelLevel('s1', 'mira')).toBe('nothing');
    expect(m.getChannelLevel('s2', '#dev')).toBe('mentions');
    expect(m.getChannelLevel('s2', 'mira')).toBe('all');
  });

  it("a channel's own level wins over the server's; Server default takes it back off", async () => {
    const m = await import('./notifications.store');
    m.setServerLevels('s1', { channels: 'nothing' });
    m.setChannelLevel('s1', '#Dev', 'mentions'); // the global default, but its own
    m.__resetNotificationSettingsCache();
    expect(m.getOwnChannelLevel('s1', '#dev')).toBe('mentions');
    expect(m.getChannelLevel('s1', '#dev')).toBe('mentions');
    expect(m.getChannelLevel('s1', '#ops')).toBe('nothing');
    m.setChannelLevel('s1', '#dev', 'default');
    expect(m.getOwnChannelLevel('s1', '#dev')).toBeUndefined();
    expect(m.getChannelLevel('s1', '#dev')).toBe('nothing');
  });

  it("lists a server's conversations with their own level, channels first", async () => {
    const m = await import('./notifications.store');
    m.setChannelLevel('s1', 'mira', 'nothing');
    m.setChannelLevel('s1', '#ops', 'all');
    m.setChannelLevel('s1', '#dev', 'nothing');
    m.setChannelLevel('s2', '#elsewhere', 'all');
    expect(m.ownChannelLevels('s1')).toEqual([
      { channel: '#dev', level: 'nothing' },
      { channel: '#ops', level: 'all' },
      { channel: 'mira', level: 'nothing' },
    ]);
  });

  it('storing the defaults for a server keeps nothing for it', async () => {
    const m = await import('./notifications.store');
    m.setServerLevels('s1', { channels: 'all' });
    m.setServerLevels('s1', { channels: 'mentions' });
    expect(JSON.parse(localStorage.getItem('boson:notifications:servers:v1')!)).toEqual({});
  });
});
