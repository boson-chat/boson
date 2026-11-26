import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPrefs, collectPrefs, localPrefsUpdatedAt, onLocalPrefsChange, reconcilePrefs } from './prefs-sync';
import { __resetNotificationSettingsCache, getChannelLevel, getNotificationSettings, setChannelLevel, setNotificationSettings } from '../ui/notifications.store';
import { __resetChatDisplaySettingsCache, getChatDisplaySettings, setChatDisplaySettings } from '../ui/chat-display.store';

beforeEach(() => { localStorage.clear(); __resetNotificationSettingsCache(); __resetChatDisplaySettingsCache(); });
afterEach(() => { localStorage.clear(); __resetNotificationSettingsCache(); __resetChatDisplaySettingsCache(); });

describe('prefs-sync', () => {
  it('collects only the synced keys, as stored', () => {
    setNotificationSettings({ sound: false });
    localStorage.setItem('boson:voice:v1', '{"device":"x"}'); // per device: not synced
    const p = collectPrefs();
    expect(Object.keys(p.values)).toEqual(['boson:notifications:v1']);
    expect(JSON.parse(p.values['boson:notifications:v1']!).sound).toBe(false);
  });

  it('a local change is stamped and reported; applying a synced copy is not', () => {
    let calls = 0;
    const off = onLocalPrefsChange(() => { calls++; });
    setChannelLevel('s1', '#dev', 'all');
    expect(calls).toBe(1);
    expect(localPrefsUpdatedAt()).toBeGreaterThan(0);
    applyPrefs({ updatedAt: 5, values: { 'boson:notifications:v1': '{"mentions":false}' } });
    expect(calls).toBe(1);
    expect(localPrefsUpdatedAt()).toBe(5);
    // Applied: the stores re-read; keys the copy lacks go back to defaults.
    expect(getNotificationSettings().mentions).toBe(false);
    expect(getChannelLevel('s1', '#dev')).toBe('mentions');
    off();
  });

  it('"Show guessed replies" syncs too (on by default)', () => {
    expect(getChatDisplaySettings().guessedReplies).toBe(true);
    let calls = 0;
    const off = onLocalPrefsChange(() => { calls++; });
    setChatDisplaySettings({ guessedReplies: false });
    expect(calls).toBe(1);
    expect(JSON.parse(collectPrefs().values['boson:chat-display:v1']!)).toEqual({ guessedReplies: false });
    applyPrefs({ updatedAt: 9, values: {} });
    expect(getChatDisplaySettings().guessedReplies).toBe(true);
    applyPrefs({ updatedAt: 10, values: { 'boson:chat-display:v1': '{"guessedReplies":false}' } });
    expect(getChatDisplaySettings().guessedReplies).toBe(false);
    off();
  });

  it('reconcile: the newer side wins; a first sync starts from this device', () => {
    expect(reconcilePrefs(undefined)).toBe('same'); // nothing anywhere
    setNotificationSettings({ sound: false });
    localStorage.removeItem('boson:prefs-sync:v1'); // set before syncing existed
    expect(reconcilePrefs(undefined)).toBe('push');
    const here = localPrefsUpdatedAt();
    expect(here).toBeGreaterThan(0);
    expect(reconcilePrefs({ updatedAt: here - 1, values: {} })).toBe('push');
    expect(reconcilePrefs({ updatedAt: here, values: {} })).toBe('same');
    expect(reconcilePrefs({ updatedAt: here + 1, values: { 'boson:notifications:v1': '{"sound":true}' } })).toBe('applied');
    expect(getNotificationSettings().sound).toBe(true);
    expect(reconcilePrefs({ updatedAt: 1, values: { x: 3 } })).toBe('push'); // malformed: ours goes up
  });
});
