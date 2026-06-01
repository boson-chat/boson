import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { ServerSettings } from './ServerSettings';
import {
  LocalStorageServiceCredentialsStore,
  setServiceCredentialsStore,
  getServiceCredentialsStore,
} from '../../modules/chat/services-credentials';

// Advanced is the raw-command playground (NickServ raw, ChanServ, user
// modes, lookups, server info, memos, cloak). The status-aware account
// UI lives on the Identity tab — those tests are in
// `ServerSettings.identity.test.tsx`. This file covers only what's
// inside Advanced.

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  };
}

let savedStore: ReturnType<typeof getServiceCredentialsStore>;

beforeEach(() => {
  savedStore = getServiceCredentialsStore();
  setServiceCredentialsStore(new LocalStorageServiceCredentialsStore(memStorage()));
});

afterEach(() => {
  setServiceCredentialsStore(savedStore);
});

function baseProps(overrides: Partial<Parameters<typeof ServerSettings>[0]> = {}) {
  return {
    serverDisplayName: 'Boson HQ',
    myNick: 'alice',
    serverInfo: {},
    serverLog: [],
    onClearServerLog: vi.fn(),
    onClose: vi.fn(),
    serverId: 'libera',
    servicesFramework: null,
    onTriggerAutoIdentify: vi.fn(),
    onRunCommand: vi.fn(),
    ...overrides,
  } as Parameters<typeof ServerSettings>[0];
}

function switchToAdvanced(): void {
  fireEvent.click(screen.getByRole('tab', { name: /Advanced/ }));
}

// Inner-tab switcher — Advanced has its own Tabs row (NickServ /
// Account / Lookups / ChanServ / Modes / Server / Memos / Cloak).
function switchAdvancedTab(label: string): void {
  const tabs = screen.getAllByRole('tab', { name: label });
  // Outer ServerSettings menu also uses role=tab; inner Advanced tab
  // is the second match for any duplicate label.
  fireEvent.click(tabs[tabs.length - 1]!);
}

describe('ServerSettings — Advanced (raw commands)', () => {
  it('exposes the Advanced tab in the outer menu', () => {
    render(<ServerSettings {...baseProps()} />);
    expect(screen.getByRole('tab', { name: /Advanced/ })).toBeInTheDocument();
  });

  // ---- Lookups tab — WHOIS form ----------------------------------------

  it('WHOIS form on the Lookups tab routes "/whois <nick>" through onRunCommand', async () => {
    const onRunCommand = vi.fn();
    const { container } = render(<ServerSettings {...baseProps({ onRunCommand })} />);
    switchToAdvanced();
    switchAdvancedTab('Lookups');
    const whoisLabel = Array.from(container.querySelectorAll('.server-settings-cmd-label'))
      .find((el) => el.textContent === 'WHOIS');
    expect(whoisLabel).toBeDefined();
    const row = whoisLabel!.closest('.server-settings-cmd-row') as HTMLElement;
    const input = row.querySelector('input[placeholder="nick"]') as HTMLInputElement;
    await userEvent.setup().type(input, 'bob');
    fireEvent.click(row.querySelector('button[type="submit"]') as HTMLButtonElement);
    expect(onRunCommand).toHaveBeenCalledWith('/whois bob');
  });

  it('WHOIS submit button is disabled until a nick is typed', () => {
    const { container } = render(<ServerSettings {...baseProps()} />);
    switchToAdvanced();
    switchAdvancedTab('Lookups');
    const whoisLabel = Array.from(container.querySelectorAll('.server-settings-cmd-label'))
      .find((el) => el.textContent === 'WHOIS')!;
    const row = whoisLabel.closest('.server-settings-cmd-row') as HTMLElement;
    expect(row.querySelector('button[type="submit"]')).toBeDisabled();
  });

  // ---- Search filter ---------------------------------------------------

  it('search filters command rows by label substring (case-insensitive), across all tabs', async () => {
    const { container } = render(<ServerSettings {...baseProps()} />);
    switchToAdvanced();
    const labels = (): string[] => Array.from(container.querySelectorAll('.server-settings-cmd-label'))
      .map((el) => el.textContent ?? '');
    const search = container.querySelector('.server-settings-advanced-search input') as HTMLInputElement;
    expect(search).not.toBeNull();
    await userEvent.setup().type(search, 'whois');
    const filtered = labels();
    expect(filtered).toContain('WHOIS');
    expect(filtered).not.toContain('MOTD');
    expect(filtered).not.toContain('IDENTIFY');
  });

  it('search matches against hint text — typing "ban" surfaces ChanServ BAN', async () => {
    const { container } = render(<ServerSettings {...baseProps()} />);
    switchToAdvanced();
    const search = container.querySelector('.server-settings-advanced-search input') as HTMLInputElement;
    await userEvent.setup().type(search, 'ban');
    const labels = Array.from(container.querySelectorAll('.server-settings-cmd-label'))
      .map((el) => el.textContent ?? '');
    expect(labels).toContain('BAN');
  });

  it('hides entire cards whose rows have all been filtered out during a search', async () => {
    const { container } = render(<ServerSettings {...baseProps()} />);
    switchToAdvanced();
    const cardHeaders = (): string[] => Array.from(container.querySelectorAll('.server-settings-subhead'))
      .map((el) => el.textContent ?? '');
    const search = container.querySelector('.server-settings-advanced-search input') as HTMLInputElement;
    await userEvent.setup().type(search, 'whois');
    expect(cardHeaders()).toContain('Lookups');     // hosts WHOIS
    expect(cardHeaders()).not.toContain('HostServ'); // collapsed
    expect(cardHeaders()).not.toContain('MemoServ'); // collapsed
  });

  // ---- Output capture --------------------------------------------------

  it('shows "(no reply captured)" when nothing arrives within the capture window', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(
        <ServerSettings {...baseProps({ onRunCommand: vi.fn(), serverLog: [] })} />,
      );
      switchToAdvanced();
      switchAdvancedTab('Server'); // MOTD lives on the Server tab
      const motdLabel = Array.from(container.querySelectorAll('.server-settings-cmd-label'))
        .find((el) => el.textContent === 'MOTD');
      expect(motdLabel).toBeDefined();
      const row = motdLabel!.closest('.server-settings-cmd-row') as HTMLElement;
      act(() => { (row.querySelector('button') as HTMLButtonElement).click(); });
      expect(container.querySelector('.server-settings-cmd-output-running')?.textContent)
        .toMatch(/Listening for reply/);
      act(() => { vi.advanceTimersByTime(4000); });
      expect(container.querySelector('.server-settings-cmd-output')?.textContent)
        .toBe('(no reply captured)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('captures and displays a server NOTICE reply that lands inside the capture window', () => {
    vi.useFakeTimers();
    try {
      const replyEntry = {
        id: 'r1',
        kind: 'NOTICE',
        from: 'NickServ',
        target: 'me',
        message: 'Last seen: 12 hours ago',
        timestamp: Date.now() + 1,
      };
      const { container, rerender } = render(
        <ServerSettings {...baseProps({ onRunCommand: vi.fn(), serverLog: [] })} />,
      );
      switchToAdvanced();
      switchAdvancedTab('NickServ');
      const infoLabel = Array.from(container.querySelectorAll('.server-settings-cmd-label'))
        .find((el) => el.textContent === 'INFO');
      const row = infoLabel!.closest('.server-settings-cmd-row') as HTMLElement;
      const input = row.querySelector('input[type="text"]') as HTMLInputElement;
      act(() => {
        input.value = 'alice';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const button = row.querySelector('button[type="submit"]') as HTMLButtonElement;
      act(() => { button.click(); });
      rerender(
        <ServerSettings {...baseProps({ onRunCommand: vi.fn(), serverLog: [replyEntry] })} />,
      );
      act(() => { vi.advanceTimersByTime(4000); });
      expect(container.querySelector('.server-settings-cmd-output')?.textContent)
        .toMatch(/Last seen: 12 hours ago/);
    } finally {
      vi.useRealTimers();
    }
  });
});
