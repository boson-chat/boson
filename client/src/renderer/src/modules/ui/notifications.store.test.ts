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
