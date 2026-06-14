import { describe, it, expect, beforeEach } from 'vitest';
import {
  getEmbedSettings, setEmbedSettings, embedKindEnabled,
  DEFAULT_EMBED_SETTINGS, __resetEmbedSettingsCache,
} from './embeds.store';

beforeEach(() => {
  localStorage.clear();
  __resetEmbedSettingsCache();
});

describe('embeds.store', () => {
  it('defaults to enabled + auto-load + all types on', () => {
    expect(getEmbedSettings()).toEqual(DEFAULT_EMBED_SETTINGS);
    expect(DEFAULT_EMBED_SETTINGS.loadMode).toBe('auto');
  });

  it('persists a patch and reflects it on reload', () => {
    setEmbedSettings({ loadMode: 'auto', images: false });
    __resetEmbedSettingsCache(); // simulate a fresh read
    const s = getEmbedSettings();
    expect(s.loadMode).toBe('auto');
    expect(s.images).toBe(false);
    expect(s.youtube).toBe(true);
  });

  it('embedKindEnabled gates by master switch + per-type', () => {
    setEmbedSettings({ enabled: true, images: false, youtube: true, websites: true });
    const s = getEmbedSettings();
    expect(embedKindEnabled(s, 'image')).toBe(false);
    expect(embedKindEnabled(s, 'youtube')).toBe(true);
    expect(embedKindEnabled(s, 'file')).toBe(true); // file links always offered
    setEmbedSettings({ videos: false });
    expect(embedKindEnabled(getEmbedSettings(), 'video')).toBe(false);
    setEmbedSettings({ videos: true });
    expect(embedKindEnabled(getEmbedSettings(), 'video')).toBe(true);
    setEmbedSettings({ spotify: false });
    expect(embedKindEnabled(getEmbedSettings(), 'spotify')).toBe(false);
    setEmbedSettings({ spotify: true });
    expect(embedKindEnabled(getEmbedSettings(), 'spotify')).toBe(true);
    setEmbedSettings({ enabled: false });
    const off = getEmbedSettings();
    expect(embedKindEnabled(off, 'youtube')).toBe(false);
    expect(embedKindEnabled(off, 'file')).toBe(false);
  });
});
