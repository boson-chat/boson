import { describe, it, expect, beforeEach } from 'vitest';
import {
  MAX_NETWORK_THEME_BYTES, chooseVariant, contrastRatio, cssUrl, isBrandingUrl, mergeNetworkTheme, paneVars, parseNetworkTheme,
  themeHasLook, themeImages, type NetworkTheme,
} from './network-theme';
import { ThemeStore } from './theme.store';
import { baseTheme, BUILTIN_THEMES } from './themes.builtin';
import type { Theme } from './theme.types';

const terminal = baseTheme('dark');
const daylight = baseTheme('light');
const nord = BUILTIN_THEMES.find((b) => b.id === 'nord')!.theme;

const net = (over: Partial<NetworkTheme> = {}): NetworkTheme => ({ version: 1, base: 'dark', colors: {}, panes: {}, ...over });

describe('parseNetworkTheme', () => {
  it('reads a full document', () => {
    const t = parseNetworkTheme(JSON.stringify({
      version: 1,
      base: 'light',
      colors: { accent: '#7C3AED', bg: '#0b0b10' },
      nick: { saturation: 62, lightness: 64 },
      radius: 2,
      font: 'system',
      panes: {
        servers: { bg: '#0b0b10' },
        channels: { bg: '#111118', image: 'https://ex.org/c.webp', dim: 0.6, blur: 0 },
        messages: { image: 'https://ex.org/m.webp', dim: 0.7, blur: 8, position: 'top' },
        members: { bg: '#111118' },
      },
      logo: 'https://ex.org/logo.svg',
      logo_wide: 'https://ex.org/wide.svg',
      login_background: 'https://ex.org/login.webp',
    }));
    expect(t).toEqual({
      version: 1,
      base: 'light',
      colors: { accent: '#7c3aed', bg: '#0b0b10' },
      nick: { saturation: 62, lightness: 64 },
      radius: 2,
      font: 'system',
      panes: {
        servers: { bg: '#0b0b10' },
        channels: { bg: '#111118', image: 'https://ex.org/c.webp', dim: 0.6, blur: 0 },
        messages: { image: 'https://ex.org/m.webp', dim: 0.7, blur: 8, position: 'top' },
        members: { bg: '#111118' },
      },
      logo: 'https://ex.org/logo.svg',
      logo_wide: 'https://ex.org/wide.svg',
      login_background: 'https://ex.org/login.webp',
    });
  });

  it('only takes #rrggbb colours for known tokens', () => {
    const t = parseNetworkTheme({
      colors: {
        accent: '#abc', fg: 'red', bg: 'rgb(0,0,0)', surface: '#12345678', border: 'url(x)',
        'fg-2': '#a1b2c3', nope: '#000000', muted: 12,
      },
    })!;
    expect(t.colors).toEqual({ 'fg-2': '#a1b2c3' });
  });

  it('drops out-of-range and unknown values instead of clamping', () => {
    const t = parseNetworkTheme({
      base: 'sepia',
      nick: { saturation: 101, lightness: -1 },
      radius: 13,
      font: 'comic',
      extra: { anything: true },
      panes: {
        messages: { dim: 1.5, blur: 25, position: 'middle', bg: 'black', image: 'http://ex.org/x.png' },
        sidebar: { bg: '#000000' },
        channels: { dim: 0, blur: 24, position: 'right' },
      },
      logo: 'javascript:alert(1)',
      login_background: 'https://user:pw@ex.org/x.png',
    })!;
    expect(t.base).toBe('dark');
    expect(t.nick).toBeUndefined();
    expect(t.radius).toBeUndefined();
    expect(t.font).toBeUndefined();
    expect(t.panes).toEqual({ channels: { dim: 0, blur: 24, position: 'right' } });
    expect(t.logo).toBeUndefined();
    expect(t.login_background).toBeUndefined();
    expect('extra' in t).toBe(false);
  });

  it('refuses what is not a theme document', () => {
    expect(parseNetworkTheme('not json')).toBeNull();
    expect(parseNetworkTheme('[1,2]')).toBeNull();
    expect(parseNetworkTheme(null)).toBeNull();
    expect(parseNetworkTheme({ version: 2, colors: { accent: '#000000' } })).toBeNull();
    // 16 KB, the text or the parsed value.
    const pad = 'x'.repeat(MAX_NETWORK_THEME_BYTES);
    expect(parseNetworkTheme(JSON.stringify({ version: 1, pad }))).toBeNull();
    expect(parseNetworkTheme({ version: 1, pad })).toBeNull();
    // No version: a listing's theme may leave it out.
    expect(parseNetworkTheme({ colors: { accent: '#000000' } })?.colors.accent).toBe('#000000');
  });

  it('allows http image URLs only on loopback, and only in dev builds', () => {
    const doc = { logo: 'http://127.0.0.1:9000/logo.png', login_background: 'http://example.org/bg.png' };
    expect(parseNetworkTheme(doc)!.logo).toBeUndefined();
    const dev = parseNetworkTheme(doc, { allowLoopbackHttp: true })!;
    expect(dev.logo).toBe('http://127.0.0.1:9000/logo.png');
    expect(dev.login_background).toBeUndefined();
    expect(isBrandingUrl('https://ex.org/a.png')).toBe(true);
    expect(isBrandingUrl('http://localhost/a.png', { allowLoopbackHttp: true })).toBe(true);
    expect(isBrandingUrl('http://[::1]/a.png', { allowLoopbackHttp: true })).toBe(true);
    expect(isBrandingUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isBrandingUrl(`https://ex.org/${'a'.repeat(2100)}`)).toBe(false);
  });

  it('lists its images and says whether it changes the look', () => {
    const t = parseNetworkTheme({
      logo: 'https://ex.org/l.png',
      panes: { members: { image: 'https://ex.org/m.png' } },
    })!;
    expect(themeImages(t)).toEqual({ logo: 'https://ex.org/l.png', 'panes.members.image': 'https://ex.org/m.png' });
    expect(themeHasLook(t)).toBe(true);
    expect(themeHasLook(parseNetworkTheme({ logo: 'https://ex.org/l.png' })!)).toBe(false);
  });
});

describe('contrastRatio', () => {
  it('is the WCAG ratio', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#fff', '#fff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 1);
    expect(contrastRatio('oklch(0.5 0.1 200)', '#ffffff')).toBeNull();
  });
});

describe('mergeNetworkTheme', () => {
  it("takes the network's colours over the user's theme of the same base", () => {
    const r = mergeNetworkTheme(nord, net({ colors: { accent: '#7c3aed' }, radius: 6, font: 'system', nick: { lightness: 70 } }));
    expect(r.theme.colors.accent).toBe('#7c3aed');
    expect(r.theme.colors.bg).toBe(nord.colors.bg);
    expect(r.theme.radius).toBe(6);
    expect(r.theme.font).toBe('system');
    expect(r.theme.nick).toEqual({ saturation: nord.nick.saturation, lightness: 70 });
    expect(r.droppedText).toBe(false);
  });

  it("fills a network of the other base from Boson's built-in of that base", () => {
    const r = mergeNetworkTheme(nord, net({ base: 'light', colors: { accent: '#7c3aed' } }));
    expect(r.theme.base).toBe('light');
    expect(r.theme.colors.bg).toBe(daylight.colors.bg);
    expect(r.theme.colors.fg).toBe(daylight.colors.fg);
    expect(r.theme.nick).toEqual(daylight.nick);
  });

  it("drops the network's text colours when they'd be unreadable, keeping yours", () => {
    // Grey text on a dark grey background: about 1.6:1.
    const r = mergeNetworkTheme(terminal, net({ colors: { bg: '#202020', fg: '#404040', 'fg-2': '#505050', accent: '#ff0066' } }));
    expect(r.droppedText).toBe(true);
    expect(r.droppedSurfaces).toBe(false);
    expect(r.theme.colors.fg).toBe(terminal.colors.fg);
    expect(r.theme.colors['fg-2']).toBe(terminal.colors['fg-2']);
    // The rest of the theme stays.
    expect(r.theme.colors.bg).toBe('#202020');
    expect(r.theme.colors.accent).toBe('#ff0066');
    expect(contrastRatio(r.theme.colors.fg, r.theme.colors.bg)!).toBeGreaterThanOrEqual(4.5);
  });

  it('drops its surfaces too when your text is unreadable on them', () => {
    // A near-white background under a dark theme's light text.
    const r = mergeNetworkTheme(terminal, net({ colors: { bg: '#f0f0f0', surface: '#ffffff', fg: '#eeeeee' } }));
    expect(r.droppedText).toBe(true);
    expect(r.droppedSurfaces).toBe(true);
    expect(r.theme.colors.bg).toBe(terminal.colors.bg);
    expect(r.theme.colors.surface).toBe(terminal.colors.surface);
  });

  it('keeps readable text and drops an unreadable pane background', () => {
    const r = mergeNetworkTheme(terminal, net({
      colors: { fg: '#ffffff', bg: '#000000' },
      panes: { channels: { bg: '#f8f8f8', image: 'https://ex.org/a.png' }, members: { bg: '#101010' } },
    }));
    expect(r.droppedText).toBe(false);
    expect(r.droppedPanes).toEqual(['channels']);
    expect(r.panes).toEqual({ channels: { image: 'https://ex.org/a.png' }, members: { bg: '#101010' } });
  });

  it("doesn't judge colours it can't read (a custom theme's oklch)", () => {
    const custom: Theme = { ...terminal, colors: { ...terminal.colors, fg: 'oklch(0.9 0 0)' } };
    const r = mergeNetworkTheme(custom, net({ colors: { bg: '#ffffff' } }));
    expect(r.droppedText).toBe(false);
    expect(r.theme.colors.bg).toBe('#ffffff');
  });
});

describe('network theme variants', () => {
  const doc = {
    version: 1,
    base: 'dark',
    colors: { accent: '#7c3aed', bg: '#0b0b14' },
    nick: { lightness: 64 },
    radius: 4,
    panes: {
      servers: { bg: '#160f2a' },
      messages: { image: 'https://ex.org/m.png', dim: 0.7, blur: 8 },
      channels: { image: 'https://ex.org/c.png' },
    },
    variants: {
      light: {
        colors: { accent: '#6d28d9', bg: '#fafafa', nope: '#000000', fg: 'red' },
        nick: { lightness: 40, saturation: 400 },
        panes: {
          servers: { bg: '#ede9fe' },
          messages: { dim: 0.3 },
          channels: { image: 'https://ex.org/c-light.png', position: 'diagonal' },
          bogus: { bg: '#000000' },
        },
        extra: true,
      },
      dark: { colors: { accent: '#ff0000' } },
      sepia: { colors: { accent: '#00ff00' } },
    },
  };

  it('parses the variant for the other base by the same rules', () => {
    const t = parseNetworkTheme(doc)!;
    expect(t.variants).toEqual({
      light: {
        colors: { accent: '#6d28d9', bg: '#fafafa' },
        nick: { lightness: 40 },
        panes: {
          servers: { bg: '#ede9fe' },
          messages: { dim: 0.3 },
          channels: { image: 'https://ex.org/c-light.png' },
        },
      },
    });
    expect(themeImages(t)['variants.light.panes.channels.image']).toBe('https://ex.org/c-light.png');
  });

  it("drops a variant for the document's own base, and non-object variants", () => {
    expect(parseNetworkTheme({ base: 'dark', variants: { dark: { colors: { accent: '#ff0000' } } } })!.variants).toBeUndefined();
    expect(parseNetworkTheme({ base: 'light', variants: { light: {}, dark: 'x' } })!.variants).toBeUndefined();
    expect(parseNetworkTheme({ base: 'light', variants: [{ colors: {} }] })!.variants).toBeUndefined();
    // An empty one still counts: "Boson's dark, with the shared bits".
    expect(parseNetworkTheme({ base: 'light', variants: { dark: {} } })!.variants).toEqual({ dark: { colors: {}, panes: {} } });
  });

  it('allows variant pane images by the same URL rules', () => {
    const t = parseNetworkTheme({ variants: { light: { panes: { messages: { image: 'http://127.0.0.1:9/m.png' } } } } })!;
    expect(t.variants?.light?.panes).toEqual({});
    const dev = parseNetworkTheme({ variants: { light: { panes: { messages: { image: 'http://127.0.0.1:9/m.png' } } } } }, { allowLoopbackHttp: true })!;
    expect(dev.variants?.light?.panes.messages?.image).toBe('http://127.0.0.1:9/m.png');
  });

  it('a variant alone changes the look', () => {
    expect(themeHasLook(parseNetworkTheme({ variants: { light: { colors: { accent: '#123456' } } } })!)).toBe(true);
    expect(themeHasLook(parseNetworkTheme({ variants: { light: {} } })!)).toBe(false);
  });

  it("picks the variant for the user's base, else the primary", () => {
    const t = parseNetworkTheme(doc)!;
    const dark = chooseVariant(t, 'dark');
    expect(dark.variant).toBe(false);
    expect(dark.base).toBe('dark');
    expect(dark.colors.accent).toBe('#7c3aed');
    expect(dark.imageSlots).toEqual({ messages: 'panes.messages.image', channels: 'panes.channels.image' });

    const light = chooseVariant(t, 'light');
    expect(light.variant).toBe(true);
    expect(light.base).toBe('light');
    expect(light.colors).toEqual({ accent: '#6d28d9', bg: '#fafafa' });
    expect(light.nick).toEqual({ lightness: 40 });
    // Primary panes overlaid by the variant's, field by field.
    expect(light.panes).toEqual({
      servers: { bg: '#ede9fe' },
      messages: { image: 'https://ex.org/m.png', dim: 0.3, blur: 8 },
      channels: { image: 'https://ex.org/c-light.png' },
    });
    expect(light.imageSlots).toEqual({ messages: 'panes.messages.image', channels: 'variants.light.panes.channels.image' });

    // No variant: a light user gets the dark primary, as before.
    const plain = parseNetworkTheme({ ...doc, variants: undefined })!;
    expect(chooseVariant(plain, 'light')).toMatchObject({ variant: false, base: 'dark' });
  });

  it('merges the chosen variant over a light user and the primary over a dark one', () => {
    const t = parseNetworkTheme(doc)!;
    const light = mergeNetworkTheme(daylight, t);
    expect(light.variant).toBe(true);
    expect(light.theme.base).toBe('light');
    expect(light.theme.colors.accent).toBe('#6d28d9');
    expect(light.theme.colors.bg).toBe('#fafafa');
    // Not in the variant: the user's own (same base), not the dark primary's.
    expect(light.theme.colors.surface).toBe(daylight.colors.surface);
    expect(light.theme.nick).toEqual({ saturation: daylight.nick.saturation, lightness: 40 });
    // Shared top-level bits.
    expect(light.theme.radius).toBe(4);
    expect(light.panes.servers).toEqual({ bg: '#ede9fe' });

    const dark = mergeNetworkTheme(nord, t);
    expect(dark.variant).toBe(false);
    expect(dark.theme.base).toBe('dark');
    expect(dark.theme.colors.accent).toBe('#7c3aed');
    expect(dark.theme.colors.bg).toBe('#0b0b14');
    expect(dark.theme.nick.lightness).toBe(64);
  });

  it('runs the readability guard on the chosen variant', () => {
    const t = parseNetworkTheme({
      base: 'dark',
      colors: { fg: '#ffffff', bg: '#000000' },
      panes: { members: { bg: '#101010' } },
      // Light grey text on white: unreadable.
      variants: { light: { colors: { fg: '#dddddd', accent: '#6d28d9' } } },
    })!;
    const light = mergeNetworkTheme(daylight, t);
    expect(light.droppedText).toBe(true);
    expect(light.theme.colors.fg).toBe(daylight.colors.fg);
    expect(light.theme.colors.accent).toBe('#6d28d9');
    // The primary's dark pane background is unreadable under light text.
    expect(light.droppedPanes).toEqual(['members']);
    const dark = mergeNetworkTheme(terminal, t);
    expect(dark.droppedText).toBe(false);
    expect(dark.droppedPanes).toEqual([]);
  });

  it("paneVars reads a variant's own picture from its slot", () => {
    const t = parseNetworkTheme(doc)!;
    const r = mergeNetworkTheme(daylight, t);
    const { vars } = paneVars(r.panes, {
      'panes.messages.image': 'blob:app/m',
      'panes.channels.image': 'blob:app/c-dark',
      'variants.light.panes.channels.image': 'blob:app/c-light',
    }, r.imageSlots);
    expect(vars['--pane-channels-image']).toBe('url("blob:app/c-light")');
    expect(vars['--pane-messages-image']).toBe('url("blob:app/m")');
    expect(vars['--pane-messages-dim']).toBe('0.3');
  });
});

describe('paneVars', () => {
  it('sets the pane variables, images only once loaded', () => {
    const panes = {
      servers: { bg: '#0b0b10' },
      messages: { image: 'https://ex.org/m.webp', dim: 0.7, blur: 8, position: 'top' as const },
      channels: { image: 'https://ex.org/c.webp' },
    };
    const { vars, withImage } = paneVars(panes, { 'panes.messages.image': 'blob:app/1' });
    expect(withImage).toEqual(['messages']);
    expect(vars).toEqual({
      '--pane-servers-bg': '#0b0b10',
      '--pane-messages-image': 'url("blob:app/1")',
      '--pane-messages-dim': '0.7',
      '--pane-messages-blur': '8px',
      '--pane-messages-position': 'top',
    });
    // Loaded later: the default dim, no blur, centred.
    const later = paneVars(panes, { 'panes.channels.image': 'blob:app/2' }).vars;
    expect(later['--pane-channels-dim']).toBe('0.6');
    expect(later['--pane-channels-blur']).toBe('0px');
    expect(later['--pane-channels-position']).toBe('center');
  });

  it('keeps a URL inside its url("…")', () => {
    expect(cssUrl('blob:x"); color: red; ("')).not.toContain('"');
  });
});

describe('ThemeStore network overlay', () => {
  beforeEach(() => { localStorage.clear(); });
  const prop = (el: HTMLElement, name: string): string => el.style.getPropertyValue(name);

  it("applies the network's theme over yours, its panes, and takes it off again", async () => {
    const root = document.createElement('div');
    const store = new ThemeStore(null, root);
    await store.init();
    store.setActive('nord');
    store.setNetworkOverlay({
      host: 'irc.ex.org',
      theme: net({ colors: { accent: '#7c3aed' }, radius: 4, panes: { messages: { image: 'https://ex.org/m.png', blur: 4 }, servers: { bg: '#0b0b10' } } }),
      images: { 'panes.messages.image': 'blob:app/m' },
    });
    expect(prop(root, '--accent')).toBe('#7c3aed');
    expect(prop(root, '--bg')).toBe(nord.colors.bg);
    expect(prop(root, '--radius-sm')).toBe(''); // a network theme never changes corners
    expect(prop(root, '--pane-messages-image')).toBe('url("blob:app/m")');
    expect(prop(root, '--pane-messages-blur')).toBe('4px');
    expect(prop(root, '--pane-servers-bg')).toBe('#0b0b10');
    expect(root.dataset['paneMessagesImage']).toBe('');
    expect(root.dataset['networkTheme']).toBe('irc.ex.org');
    expect(store.effectiveTheme().colors.accent).toBe('#7c3aed');

    // The editor's preview shows your own theme.
    store.setPreview({ ...nord, name: 'Draft' });
    expect(prop(root, '--accent')).toBe(nord.colors.accent);
    expect(prop(root, '--pane-messages-image')).toBe('');
    store.setPreview(null);
    expect(prop(root, '--accent')).toBe('#7c3aed');

    store.setNetworkOverlay(null);
    expect(prop(root, '--accent')).toBe(nord.colors.accent);
    expect(prop(root, '--radius-sm')).toBe('');
    expect(prop(root, '--pane-messages-image')).toBe('');
    expect(prop(root, '--pane-servers-bg')).toBe('');
    expect(root.dataset['paneMessagesImage']).toBeUndefined();
    expect(root.dataset['networkTheme']).toBeUndefined();
  });

  it("re-picks the network's variant when you switch between dark and light", async () => {
    const root = document.createElement('div');
    const store = new ThemeStore(null, root);
    await store.init();
    store.setActive('terminal');
    store.setNetworkOverlay({
      host: 'irc.ex.org',
      theme: parseNetworkTheme({
        base: 'dark',
        colors: { accent: '#7c3aed', bg: '#0b0b14' },
        panes: { servers: { bg: '#160f2a' } },
        variants: { light: { colors: { accent: '#6d28d9', bg: '#fafafa' }, panes: { servers: { bg: '#ede9fe' } } } },
      })!,
      images: {},
    });
    expect(prop(root, '--accent')).toBe('#7c3aed');
    expect(prop(root, '--bg')).toBe('#0b0b14');
    expect(prop(root, '--pane-servers-bg')).toBe('#160f2a');
    expect(root.dataset['themeBase']).toBe('dark');

    store.setActive('daylight');
    expect(prop(root, '--accent')).toBe('#6d28d9');
    expect(prop(root, '--bg')).toBe('#fafafa');
    expect(prop(root, '--surface')).toBe(daylight.colors.surface);
    expect(prop(root, '--pane-servers-bg')).toBe('#ede9fe');
    expect(root.dataset['themeBase']).toBe('light');
    expect(store.effectiveTheme().colors.accent).toBe('#6d28d9');

    store.setActive('nord');
    expect(prop(root, '--accent')).toBe('#7c3aed');
    expect(prop(root, '--surface')).toBe(nord.colors.surface);
    expect(root.dataset['themeBase']).toBe('dark');
  });
});
