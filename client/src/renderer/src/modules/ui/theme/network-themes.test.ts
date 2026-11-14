import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MAIN_NETWORK_KEY, NetworkThemes, type BrandingBridge, type NetworkThemesDeps } from './network-themes';
import type { NetworkOverlay } from './theme.store';

const DOC = JSON.stringify({ version: 1, colors: { accent: '#7c3aed' }, logo: 'https://ex.org/logo.png' });
const DOC2 = JSON.stringify({ version: 1, colors: { accent: '#0ea5e9' } });

interface Served { status: number; etag?: string; body?: string }

// A shell bridge serving documents by URL (honouring If-None-Match) and a
// 1-pixel PNG for every image.
function fakeBridge(docs: Record<string, Served>) {
  const calls: Array<{ url: string; etag: string }> = [];
  const images: string[] = [];
  const bridge: BrandingBridge = {
    allowLoopbackHttp: false,
    fetch: async (url, etag) => {
      calls.push({ url, etag });
      const d = docs[url];
      if (!d) return { status: 404 };
      if (etag && d.etag === etag) return { status: 304, etag };
      return d;
    },
    image: async (url) => {
      images.push(url);
      return { contentType: 'image/png', data: btoa('\x89PNG') };
    },
  };
  return { bridge, calls, images };
}

function setup(over: Partial<NetworkThemesDeps> & { docs?: Record<string, Served> } = {}) {
  const { bridge, calls, images } = fakeBridge(over.docs ?? {});
  const applied: Array<NetworkOverlay | null> = [];
  let blobs = 0;
  const deps: NetworkThemesDeps = {
    bridge,
    storage: localStorage,
    createObjectURL: () => `blob:app/${++blobs}`,
    apply: (o) => applied.push(o),
    ...over,
  };
  return { themes: new NetworkThemes(deps), calls, images, applied, deps };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { localStorage.clear(); });

describe('NetworkThemes resolution', () => {
  it("1: the network's boson.json branding URL", async () => {
    const authConfig = vi.fn(async () => ({ branding_url: 'https://auth.ex.org/v1/branding' }));
    const { themes, calls } = setup({
      docs: { 'https://ex.org/theme.json': { status: 200, etag: '"a"', body: DOC } },
      discover: async () => ({ brandingUrl: 'https://ex.org/theme.json', authUrl: 'https://auth.ex.org' }),
      authConfig,
    });
    themes.setListingTheme('irc.ex.org', { colors: { accent: '#111111' } });
    await themes.refresh('irc.ex.org');
    expect(calls.map((c) => c.url)).toEqual(['https://ex.org/theme.json']);
    expect(authConfig).not.toHaveBeenCalled();
    expect(themes.themeFor('irc.ex.org')?.colors.accent).toBe('#7c3aed');
    expect(themes.brandingFor('irc.ex.org').source).toBe('well-known');
  });

  it("2: else the auth service's /v1/config branding_url", async () => {
    const { themes, calls } = setup({
      docs: { 'https://auth.ex.org/v1/branding': { status: 200, body: DOC } },
      discover: async () => ({ authUrl: 'https://auth.ex.org' }),
      authConfig: async () => ({ branding_url: 'https://auth.ex.org/v1/branding' }),
    });
    await themes.refresh('irc.ex.org');
    expect(calls.map((c) => c.url)).toEqual(['https://auth.ex.org/v1/branding']);
    expect(themes.brandingFor('irc.ex.org').source).toBe('auth');
  });

  it("3: else the directory listing's theme, also when the network's own is gone", async () => {
    const docs: Record<string, Served> = {};
    const { themes } = setup({
      docs,
      discover: async () => ({ authUrl: 'https://auth.ex.org' }),
      authConfig: async () => ({}),
    });
    themes.setListingTheme('irc.ex.org', JSON.parse(DOC2));
    await themes.refresh('irc.ex.org');
    expect(themes.themeFor('irc.ex.org')?.colors.accent).toBe('#0ea5e9');
    expect(themes.brandingFor('irc.ex.org').source).toBe('directory');
    // A listing change shows at once.
    themes.setListingTheme('irc.ex.org', { colors: { accent: '#222222' } });
    expect(themes.themeFor('irc.ex.org')?.colors.accent).toBe('#222222');
    // No listing theme any more: none.
    themes.setListingTheme('irc.ex.org', undefined);
    expect(themes.themeFor('irc.ex.org')).toBeNull();
  });

  it("a network's own theme wins over its listing's", async () => {
    const { themes } = setup({
      docs: { 'https://ex.org/theme.json': { status: 200, body: DOC } },
      discover: async () => ({ brandingUrl: 'https://ex.org/theme.json' }),
    });
    await themes.refresh('irc.ex.org');
    themes.setListingTheme('irc.ex.org', JSON.parse(DOC2));
    expect(themes.themeFor('irc.ex.org')?.colors.accent).toBe('#7c3aed');
  });

  it('a 404 or an invalid document falls back to the listing', async () => {
    const { themes } = setup({
      docs: { 'https://ex.org/bad.json': { status: 200, body: '{"version":3}' } },
      discover: async (host) => ({ brandingUrl: host === 'a.ex.org' ? 'https://ex.org/bad.json' : 'https://ex.org/missing.json' }),
    });
    for (const host of ['a.ex.org', 'b.ex.org']) {
      themes.setListingTheme(host, JSON.parse(DOC2));
      await themes.refresh(host);
      expect(themes.themeFor(host)?.colors.accent).toBe('#0ea5e9');
    }
  });

  it('refuses a branding URL that is not https', async () => {
    const { themes, calls } = setup({
      discover: async () => ({ brandingUrl: 'http://ex.org/theme.json' }),
    });
    await themes.refresh('irc.ex.org');
    expect(calls).toEqual([]);
    expect(themes.themeFor('irc.ex.org')).toBeNull();
  });
});

describe('NetworkThemes cache', () => {
  it('caches the document with its ETag, revalidates on refresh, and survives a restart', async () => {
    const docs: Record<string, Served> = { 'https://ex.org/theme.json': { status: 200, etag: '"v1"', body: DOC } };
    const discover = async () => ({ brandingUrl: 'https://ex.org/theme.json' });
    const first = setup({ docs, discover });
    await first.themes.refresh('IRC.ex.org');
    expect(first.calls).toEqual([{ url: 'https://ex.org/theme.json', etag: '' }]);

    // Next launch: the colours are there before anything is fetched.
    const second = setup({ docs, discover });
    expect(second.themes.themeFor('irc.ex.org')?.colors.accent).toBe('#7c3aed');
    await second.themes.refresh('irc.ex.org', { force: true });
    expect(second.calls).toEqual([{ url: 'https://ex.org/theme.json', etag: '"v1"' }]);
    expect(second.themes.themeFor('irc.ex.org')?.colors.accent).toBe('#7c3aed');

    // Changed on the server: the new one replaces it.
    docs['https://ex.org/theme.json'] = { status: 200, etag: '"v2"', body: DOC2 };
    await second.themes.refresh('irc.ex.org', { force: true });
    expect(second.themes.themeFor('irc.ex.org')?.colors.accent).toBe('#0ea5e9');
  });

  it('keeps the cached theme while the network is unreachable', async () => {
    const docs: Record<string, Served> = { 'https://ex.org/theme.json': { status: 200, body: DOC } };
    const discover = async () => ({ brandingUrl: 'https://ex.org/theme.json' });
    await setup({ docs, discover }).themes.refresh('irc.ex.org');
    docs['https://ex.org/theme.json'] = { status: 0 };
    const again = setup({ docs, discover });
    await again.themes.refresh('irc.ex.org', { force: true });
    expect(again.themes.themeFor('irc.ex.org')?.colors.accent).toBe('#7c3aed');
  });

  it('dedupes refreshes and skips one right after another unless forced', async () => {
    const docs: Record<string, Served> = { 'https://ex.org/theme.json': { status: 200, body: DOC } };
    const { themes, calls } = setup({ docs, discover: async () => ({ brandingUrl: 'https://ex.org/theme.json' }) });
    await Promise.all([themes.refresh('irc.ex.org'), themes.refresh('irc.ex.org')]);
    await themes.refresh('irc.ex.org');
    expect(calls).toHaveLength(1);
    await themes.refresh('irc.ex.org', { force: true });
    expect(calls).toHaveLength(2);
  });

  it("drops a cached entry that doesn't validate any more", () => {
    localStorage.setItem('boson:network-themes:v1', JSON.stringify({ 'irc.ex.org': { source: 'directory', text: '{"version":9}' } }));
    expect(setup().themes.themeFor('irc.ex.org')).toBeNull();
  });
});

describe('NetworkThemes apply', () => {
  it("applies the active server's theme, with its images as blob: URLs", async () => {
    const { themes, applied, images } = setup({
      docs: { 'https://ex.org/theme.json': { status: 200, body: DOC } },
      discover: async () => ({ brandingUrl: 'https://ex.org/theme.json' }),
    });
    await themes.refresh('irc.ex.org');
    themes.setActive('irc.ex.org');
    await flush();
    expect(images).toEqual(['https://ex.org/logo.png']);
    const last = applied.at(-1)!;
    expect(last.host).toBe('irc.ex.org');
    expect(last.theme.colors.accent).toBe('#7c3aed');
    expect(last.images.logo).toMatch(/^blob:app\//);
    expect(themes.brandingFor('irc.ex.org').logo).toBe(last.images.logo);
    // Another server without a theme: none.
    themes.setActive('irc.other.org');
    expect(applied.at(-1)).toBeNull();
    themes.setActive('irc.ex.org');
    expect(applied.at(-1)?.host).toBe('irc.ex.org');
  });

  it('the per-network and global switches turn it off, and are remembered', async () => {
    const opts = {
      docs: { 'https://ex.org/theme.json': { status: 200, body: DOC } },
      discover: async () => ({ brandingUrl: 'https://ex.org/theme.json' }),
    };
    const { themes, applied } = setup(opts);
    await themes.refresh('irc.ex.org');
    themes.setActive('irc.ex.org');
    await flush();
    expect(applied.at(-1)).not.toBeNull();

    themes.setNetworkEnabled('irc.ex.org', false);
    expect(applied.at(-1)).toBeNull();
    const off = themes.brandingFor('irc.ex.org');
    expect(off).toMatchObject({ available: true, enabled: false, applied: false });
    expect(off.logo).toBeUndefined();
    themes.setNetworkEnabled('irc.ex.org', true);
    expect(applied.at(-1)?.host).toBe('irc.ex.org');

    themes.setGloballyEnabled(false);
    expect(applied.at(-1)).toBeNull();
    expect(themes.brandingFor('irc.ex.org').applied).toBe(false);

    const again = setup(opts).themes;
    expect(again.globallyEnabled).toBe(false);
    again.setGloballyEnabled(true);
    again.setNetworkEnabled('IRC.EX.ORG', false);
    expect(setup(opts).themes.isNetworkEnabled('irc.ex.org')).toBe(false);
  });

  it('without the shell, fetches directly and checks the image type', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('.json')) return new Response(DOC, { status: 200, headers: { ETag: '"x"' } });
      if (url.endsWith('logo.png')) return new Response(new Blob(['png'], { type: 'image/png' }));
      return new Response('<html>', { headers: { 'Content-Type': 'text/html' } });
    });
    const { themes } = setup({
      bridge: null,
      fetch: fetchImpl as unknown as typeof fetch,
      discover: async () => ({ brandingUrl: 'https://ex.org/theme.json' }),
    });
    await themes.refresh('irc.ex.org');
    expect(themes.themeFor('irc.ex.org')?.colors.accent).toBe('#7c3aed');
    themes.setActive('irc.ex.org');
    await flush();
    await flush();
    expect(themes.brandingFor('irc.ex.org').logo).toMatch(/^blob:/);
  });

  it("boson.chat's own branding for the login screen", async () => {
    const { themes } = setup({
      docs: { 'https://auth.boson.chat/v1/branding': { status: 200, body: DOC } },
    });
    await themes.refreshMain(async () => ({ branding_url: 'https://auth.boson.chat/v1/branding' }));
    expect(themes.themeFor(MAIN_NETWORK_KEY)?.colors.accent).toBe('#7c3aed');
    await themes.refreshMain(async () => ({}), { force: true });
    expect(themes.themeFor(MAIN_NETWORK_KEY)).toBeNull();
  });
});
