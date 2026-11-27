import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { LoginScreen } from './LoginScreen';
import { AuthProvider, type AuthService } from '../../modules/auth';
import type { DirectoryService } from '../../modules/directory';
import type { IdentityService } from '../../modules/identity';
import {
  MAIN_NETWORK_KEY, NetworkThemes, ThemeStore, setNetworkThemes, type NetworkOverlay,
} from '../../modules/ui/theme';

// The sign-in screen wears the network's theme (its colours, not just its
// logo and background), like the chat does for the active server: the
// home network's, under the same switches, and the defaults come back
// when it goes.

const THEME = {
  version: 1, base: 'dark', font: 'system',
  colors: {
    bg: '#0b1410', surface: '#101c17', 'surface-raised': '#16251e', 'surface-hover': '#1c2e26', border: '#2a4237', 'border-soft': '#1f3329',
    fg: '#e6f2ec', 'fg-2': '#b2c7bd', 'fg-3': '#86a094', accent: '#70d199', 'accent-on': '#06110b',
  },
  variants: {
    light: {
      colors: {
        bg: '#f6fbf8', surface: '#ffffff', 'surface-raised': '#ffffff', 'surface-hover': '#eaf4ee', border: '#c9dcd1', 'border-soft': '#dde9e2',
        fg: '#0d1a13', 'fg-2': '#3a5246', 'fg-3': '#5d7468', accent: '#1f8a52', 'accent-on': '#ffffff',
      },
    },
  },
};

const memoryStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
};

const auth = {
  getState: () => ({ session: null, loading: false, error: null }),
  subscribe: () => () => {},
} as unknown as AuthService;
const directory = { listServers: vi.fn(async () => []) } as unknown as DirectoryService;
const identity = { isUnlocked: () => false, getState: () => ({ status: 'locked' }), subscribe: () => () => {} } as unknown as IdentityService;

function renderLogin() {
  return render(
    <AuthProvider service={auth}>
      <LoginScreen directory={directory} identity={identity} accounts={null} />
    </AuthProvider>,
  );
}

let themes: NetworkThemes;
let store: ThemeStore;
let root: HTMLElement;
const applied = vi.fn<(o: NetworkOverlay | null) => void>();

beforeEach(() => {
  localStorage.clear();
  applied.mockReset();
  root = document.createElement('div');
  store = new ThemeStore(null, root);
  themes = new NetworkThemes({
    storage: memoryStorage(), bridge: null,
    apply: (o) => { applied(o); store.setNetworkOverlay(o); },
  });
  setNetworkThemes(themes);
});
afterEach(() => { cleanup(); setNetworkThemes(null); });

const accent = (): string => root.style.getPropertyValue('--accent');

describe('LoginScreen network theme', () => {
  it("applies the home network's colours while its sign-in is shown, and restores the defaults after", () => {
    store.setPreview(null);
    const before = accent();
    themes.setListingTheme(MAIN_NETWORK_KEY, THEME);
    const view = renderLogin();
    expect(applied).toHaveBeenLastCalledWith(expect.objectContaining({ host: MAIN_NETWORK_KEY }));
    expect(accent()).toBe('#70d199');
    expect(root.style.getPropertyValue('--bg')).toBe('#0b1410');
    view.unmount();
    expect(applied).toHaveBeenLastCalledWith(null);
    expect(accent()).toBe(before);
  });

  it('uses the light variant in light mode', () => {
    store.setActive('daylight');
    themes.setListingTheme(MAIN_NETWORK_KEY, THEME);
    renderLogin();
    expect(accent()).toBe('#1f8a52');
    expect(root.style.getPropertyValue('--bg')).toBe('#f6fbf8');
  });

  it('honours "Use network themes" off', () => {
    themes.setListingTheme(MAIN_NETWORK_KEY, THEME);
    themes.setGloballyEnabled(false);
    renderLogin();
    expect(accent()).not.toBe('#70d199');
    themes.setGloballyEnabled(true);
    expect(accent()).toBe('#70d199');
  });

  it("an unthemed network keeps Boson's look", () => {
    store.setPreview(null);
    const before = accent();
    renderLogin();
    expect(applied).not.toHaveBeenCalledWith(expect.objectContaining({ host: MAIN_NETWORK_KEY }));
    expect(accent()).toBe(before);
  });
});
