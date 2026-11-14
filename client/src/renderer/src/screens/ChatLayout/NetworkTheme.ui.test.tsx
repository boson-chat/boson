import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { ServerRail, type ServerRailTile } from './ServerRail';
import { ServerSettings } from './ServerSettings';
import { AppearancePanel } from '../UserSettings/AppearancePanel';
import { NetworkBrandHero, loginBackdrop, NetworkLoginLogo } from '../NetworkSignIn/NetworkBrand';
import { NetworkThemes, ThemeStore, setNetworkThemes, setThemeStore, type NetworkBranding } from '../../modules/ui/theme';

// Network themes in the UI: the rail tile's "Use this network's theme",
// Server settings → Appearance, Appearance → "Use network themes", and the
// sign-in branding.

const tile = (over: Partial<ServerRailTile> = {}): ServerRailTile => ({ serverId: 's1', name: 'Example', engineState: 'connected', ...over });

describe("the rail's network theme item", () => {
  it('toggles the network theme from the context menu', () => {
    const onToggle = vi.fn();
    render(
      <ServerRail
        servers={[tile({ networkTheme: { enabled: true } })]}
        activeServerId="s1"
        onSelectServer={vi.fn()}
        onBrowseServers={vi.fn()}
        onOpenServerSettings={vi.fn()}
        onToggleNetworkTheme={onToggle}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Example' }));
    const item = screen.getByRole('menuitemcheckbox', { name: "Use this network's theme" });
    expect(item.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(item);
    expect(onToggle).toHaveBeenCalledWith('s1', false);
  });

  it("isn't offered for a network without a theme", () => {
    render(
      <ServerRail
        servers={[tile()]}
        activeServerId="s1"
        onSelectServer={vi.fn()}
        onBrowseServers={vi.fn()}
        onOpenServerSettings={vi.fn()}
        onToggleNetworkTheme={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Example' }));
    expect(screen.queryByRole('menuitemcheckbox')).toBeNull();
  });
});

describe('Server settings → Appearance', () => {
  const base = {
    serverDisplayName: 'Example',
    myNick: 'me',
    serverInfo: { serverName: 'irc.ex.org', version: '', network: '', enabledCaps: [] },
    serverLog: [],
    onClearServerLog: vi.fn(),
    onClose: vi.fn(),
  } as unknown as Parameters<typeof ServerSettings>[0];

  it("switches this network's theme", () => {
    const onToggle = vi.fn();
    render(<ServerSettings {...base} networkTheme={{ enabled: true, globallyEnabled: false, onToggle }} />);
    fireEvent.click(screen.getByRole('tab', { name: /Appearance/ }));
    expect(screen.getByRole('note').textContent).toContain('off for every server');
    fireEvent.click(screen.getByLabelText("Use this network's theme"));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('has no Appearance section for a network without a theme', () => {
    render(<ServerSettings {...base} />);
    expect(screen.queryByRole('tab', { name: /Appearance/ })).toBeNull();
  });
});

describe('Appearance → Use network themes', () => {
  beforeEach(async () => {
    localStorage.clear();
    const store = new ThemeStore(null, document.createElement('div'));
    await store.init();
    setThemeStore(store);
    setNetworkThemes(new NetworkThemes({ bridge: null, storage: localStorage }));
  });
  afterEach(() => { setThemeStore(null); setNetworkThemes(null); });

  it('is on by default and turns network themes off', () => {
    render(<AppearancePanel />);
    const toggle = screen.getByLabelText('Use network themes') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    expect(localStorage.getItem('boson:network-themes:enabled')).toBe('false');
  });
});

describe('sign-in branding', () => {
  const brand: NetworkBranding = {
    available: true, hasLook: true, enabled: true, applied: true, logo: 'blob:app/logo', loginBackground: 'blob:app/bg',
  };

  it('shows the logo over the login background', () => {
    render(<NetworkBrandHero brand={brand} name="Example" />);
    const hero = screen.getByTestId('network-brand-hero');
    expect(hero.style.getPropertyValue('--netauth-hero-image')).toBe('url("blob:app/bg")');
    expect((screen.getByAltText('Example logo') as HTMLImageElement).src).toBe('blob:app/logo');
    expect(loginBackdrop(brand)).toEqual({ class: 'login-screen login-screen-branded', style: { '--login-bg-image': 'url("blob:app/bg")' } });
  });

  it('shows nothing when not applied', () => {
    const off = { ...brand, applied: false };
    const { container } = render(<><NetworkBrandHero brand={off} name="Example" /><NetworkLoginLogo brand={off} name="Example" /></>);
    expect(container.innerHTML).toBe('');
    expect(loginBackdrop(off)).toEqual({ class: 'login-screen' });
  });
});
