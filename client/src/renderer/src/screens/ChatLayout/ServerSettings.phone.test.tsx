import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/preact';
import { ServerSettings } from './ServerSettings';

type Props = Parameters<typeof ServerSettings>[0];

function props(over: Partial<Props> = {}): Props {
  return {
    serverDisplayName: 'Boson HQ',
    myNick: 'alice',
    serverInfo: { serverName: 'irc.boson.example', version: 'ergo-2.14', enabledCaps: ['sasl', 'server-time'] },
    serverLog: [],
    onClearServerLog: vi.fn(),
    onClose: vi.fn(),
    serverId: 'libera',
    ...over,
  } as Props;
}

const owner: Partial<Props> = {
  directoryEntry: { serverId: 'libera', name: 'Boson HQ', description: '', tags: [], languages: ['en'], isNsfw: false },
  onSaveProfile: vi.fn(async () => {}),
};

function phoneWidth(matches: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

const realMatchMedia = window.matchMedia;
afterEach(() => { window.matchMedia = realMatchMedia; });

const title = (): string | null | undefined => document.querySelector('.bds-page-title')?.textContent;
const rowTitles = (): string[] =>
  Array.from(document.querySelectorAll('.settings-phone-list nav .bds-row-title')).map((e) => e.textContent ?? '');
const headings = (): string[] =>
  Array.from(document.querySelectorAll('.settings-phone-heading')).map((e) => e.textContent ?? '');

describe('ServerSettings header', () => {
  it('leads with a back button on a phone', () => {
    phoneWidth(true);
    const onClose = vi.fn();
    render(<ServerSettings {...props({ onClose })} />);
    const back = screen.getByRole('button', { name: 'Close settings' });
    // The page header's back button leads; there's no corner close.
    expect(back.classList.contains('bds-page-back')).toBe(true);
    expect(screen.getAllByRole('button', { name: 'Close settings' })).toHaveLength(1);
    fireEvent.click(back);
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the corner close on a wide window', () => {
    phoneWidth(false);
    render(<ServerSettings {...props()} />);
    const close = screen.getByRole('button', { name: 'Close settings' });
    expect(close.classList.contains('bds-page-back')).toBe(false);
    expect(close.closest('.bds-page-actions')).not.toBeNull();
  });
});

describe('ServerSettings on a phone: a list that drills down', () => {
  it('opens on the grouped list with live hints, no tabs', () => {
    phoneWidth(true);
    render(<ServerSettings {...props({
      bouncerRoute: { route: true, network: 'libera' },
      connectionState: 'connected',
      servicesFramework: 'atheme',
    })} />);
    expect(screen.queryByRole('tab')).toBeNull();
    expect(rowTitles()).toEqual(['About', 'Identity', 'Bouncer', 'Actions', 'Software', 'Log', 'Advanced']);
    expect(headings()).toEqual(['This server', 'You here', 'Technical']);
    screen.getByRole('button', { name: 'About: irc.boson.example' });
    screen.getByRole('button', { name: 'Identity: alice' });
    screen.getByRole('button', { name: 'Bouncer: On · libera' });
    screen.getByRole('button', { name: 'Actions: Connected' });
    screen.getByRole('button', { name: 'Software: ergo-2.14 · 2 IRCv3 capabilities' });
    screen.getByRole('button', { name: 'Log: Empty' });
    screen.getByRole('button', { name: 'Advanced: Atheme services' });
  });

  it('a row opens its section under a page header; back returns to the list', () => {
    phoneWidth(true);
    const onClose = vi.fn();
    render(<ServerSettings {...props({ onClose })} />);
    fireEvent.click(screen.getByRole('button', { name: /^Log:/ }));
    expect(title()).toBe('Log');
    expect(screen.getByText('No entries yet.')).toBeTruthy();
    expect(document.querySelector('.settings-phone-list')).toBeNull();
    // Back goes to the list, not out of settings.
    fireEvent.click(screen.getByRole('button', { name: 'Back to settings' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(title()).toBe('Boson HQ');
    expect(rowTitles()).toContain('Log');
  });

  it('owner sections show only for the owner, under their own heading', () => {
    phoneWidth(true);
    const { unmount } = render(<ServerSettings {...props()} />);
    expect(rowTitles()).not.toContain('Edit');
    expect(rowTitles()).not.toContain('Operators');
    unmount();
    render(<ServerSettings {...props({ ...owner, isOper: true })} />);
    expect(headings()).toContain('Owner');
    screen.getByRole('button', { name: 'Edit: Listed as Boson HQ' });
    screen.getByRole('button', { name: "Operators: You're an operator" });
  });

  it('a deep link opens straight into its section; a hidden one opens the list', () => {
    phoneWidth(true);
    const { unmount } = render(<ServerSettings {...props({ initialSection: 'bouncer' })} />);
    expect(title()).toBe('Bouncer');
    fireEvent.click(screen.getByRole('button', { name: 'Back to settings' }));
    expect(rowTitles().length).toBeGreaterThan(3);
    unmount();
    // Not the owner: Edit isn't there to open.
    render(<ServerSettings {...props({ initialSection: 'edit' })} />);
    expect(title()).toBe('Boson HQ');
    expect(document.querySelector('.settings-phone-list')).not.toBeNull();
  });

  it('search filters the sections by name, hint and the settings in them', () => {
    phoneWidth(true);
    render(<ServerSettings {...props()} />);
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    fireEvent.input(search, { target: { value: 'znc' } });
    expect(rowTitles()).toEqual(['Bouncer']);
    fireEvent.input(search, { target: { value: 'zzzz' } });
    expect(screen.getByText('No settings match “zzzz”.')).toBeTruthy();
  });

  it('About’s Change goes to Identity', () => {
    phoneWidth(true);
    render(<ServerSettings {...props({ initialSection: 'about' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(title()).toBe('Identity');
  });

  it('Advanced: the command groups are a list that drills into each one', () => {
    phoneWidth(true);
    render(<ServerSettings {...props({ initialSection: 'advanced' })} />);
    expect(screen.queryByRole('tab')).toBeNull();
    const groups = screen.getByRole('navigation', { name: 'Command groups' });
    const names = within(groups).getAllByRole('button').map((b) => b.querySelector('.bds-row-title')?.textContent);
    expect(names).toEqual(['NickServ', 'Account', 'Lookups', 'ChanServ', 'Modes', 'Server', 'Memos', 'Cloak']);
    // A row's hint names the commands inside.
    within(groups).getByRole('button', { name: /^Lookups: WHOIS · WHOWAS · WHO$/ });
    fireEvent.click(within(groups).getByRole('button', { name: /^ChanServ:/ }));
    expect(title()).toBe('ChanServ');
    expect(screen.getByText('RECOVER')).toBeTruthy();
    // Back to Advanced's list, then back to settings.
    fireEvent.click(screen.getByRole('button', { name: 'Back to Advanced' }));
    expect(title()).toBe('Advanced');
    expect(screen.getByRole('navigation', { name: 'Command groups' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to settings' }));
    expect(title()).toBe('Boson HQ');
  });

  it('Advanced: searching shows every group’s hits, or says there are none', () => {
    phoneWidth(true);
    render(<ServerSettings {...props({ initialSection: 'advanced' })} />);
    const search = screen.getByRole('textbox', { name: 'Search commands' });
    fireEvent.input(search, { target: { value: 'whois' } });
    expect(screen.queryByRole('navigation', { name: 'Command groups' })).toBeNull();
    expect(screen.getAllByText('WHOIS').length).toBeGreaterThan(0);
    fireEvent.input(search, { target: { value: 'qqqq' } });
    expect(screen.getByText('No commands match “qqqq”.')).toBeTruthy();
  });
});

describe('ServerSettings on a wide window: a grouped menu', () => {
  it('groups the menu under headings and keeps the tabs', () => {
    phoneWidth(false);
    render(<ServerSettings {...props({ ...owner, initialSection: 'log' })} />);
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['About', 'Identity', 'Bouncer', 'Actions', 'Edit', 'Operators', 'Software', 'Log', 'Advanced']);
    expect(Array.from(document.querySelectorAll('.settings-menu-heading')).map((e) => e.textContent))
      .toEqual(['This server', 'You here', 'Owner', 'Technical']);
    // The deep link selected Log.
    expect(screen.getByRole('tab', { name: 'Log' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('No entries yet.')).toBeTruthy();
  });
});
