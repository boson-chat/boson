import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { ServerSettings } from './ServerSettings';
import {
  LocalStorageServiceCredentialsStore,
  setServiceCredentialsStore,
  getServiceCredentialsStore,
} from '../../modules/chat/services-credentials';

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

// The Advanced section now has its own inner Tabs row (Services /
// NickServ / Account / Lookups / ChanServ / Modes / Server / Memos /
// Cloak). Helper picks an inner tab by visible label.
function switchAdvancedTab(label: string): void {
  const tabs = screen.getAllByRole('tab', { name: label });
  // The outer ServerSettings menu also uses role="tab" — the inner
  // tab is the second match for labels that appear in both (none in
  // practice, but defensive).
  fireEvent.click(tabs[tabs.length - 1]!);
}

describe('ServerSettings — Advanced section', () => {
  it('exposes the Advanced tab in the menu', () => {
    render(<ServerSettings {...baseProps()} />);
    expect(screen.getByRole('tab', { name: /Advanced/ })).toBeInTheDocument();
  });

  it("renders 'Not detected' badge when no services have spoken yet", () => {
    render(<ServerSettings {...baseProps({ servicesFramework: null })} />);
    switchToAdvanced();
    expect(screen.getByText('Not detected')).toBeInTheDocument();
  });

  it('renders "Atheme" badge when the framework is detected', () => {
    render(<ServerSettings {...baseProps({ servicesFramework: 'atheme' })} />);
    switchToAdvanced();
    expect(screen.getByText('Atheme')).toBeInTheDocument();
  });

  it('renders "Anope" badge when the framework is detected', () => {
    render(<ServerSettings {...baseProps({ servicesFramework: 'anope' })} />);
    switchToAdvanced();
    expect(screen.getByText('Anope')).toBeInTheDocument();
  });

  it("renders 'Detected (unknown package)' when a service spoke but we couldn't classify", () => {
    render(<ServerSettings {...baseProps({ servicesFramework: 'unknown' })} />);
    switchToAdvanced();
    expect(screen.getByText(/Detected \(unknown package\)/)).toBeInTheDocument();
  });

  it('saves a NickServ password to the credentials store on submit', async () => {
    const { container } = render(<ServerSettings {...baseProps()} />);
    switchToAdvanced();
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await userEvent.setup().type(input, 'hunter2');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(getServiceCredentialsStore().get('libera')).toEqual({ nickservPassword: 'hunter2' });
  });

  it('pre-fills the input from the store on mount', () => {
    getServiceCredentialsStore().set('libera', { nickservPassword: 'persisted-pw' });
    const { container } = render(<ServerSettings {...baseProps()} />);
    switchToAdvanced();
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(input.value).toBe('persisted-pw');
  });

  it('Clear button removes the saved password', async () => {
    getServiceCredentialsStore().set('libera', { nickservPassword: 'oldpw' });
    render(<ServerSettings {...baseProps()} />);
    switchToAdvanced();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(getServiceCredentialsStore().get('libera')).toBeNull();
  });

  it("'Identify now' button fires onTriggerAutoIdentify and is only shown when a password is saved", () => {
    const onTriggerAutoIdentify = vi.fn();
    getServiceCredentialsStore().set('libera', { nickservPassword: 'pw' });
    render(<ServerSettings {...baseProps({ onTriggerAutoIdentify })} />);
    switchToAdvanced();
    fireEvent.click(screen.getByRole('button', { name: 'Identify now' }));
    expect(onTriggerAutoIdentify).toHaveBeenCalledOnce();
  });

  it("hides 'Identify now' when no password is stored", () => {
    render(<ServerSettings {...baseProps()} />);
    switchToAdvanced();
    expect(screen.queryByRole('button', { name: 'Identify now' })).toBeNull();
  });

  it('shows an empty-state notice and no form when serverId is omitted', () => {
    render(<ServerSettings {...baseProps({ serverId: undefined })} />);
    switchToAdvanced();
    expect(screen.getByText(/Saved credentials need a stable server id/)).toBeInTheDocument();
    expect(screen.queryByLabelText('NickServ password')).toBeNull();
  });

  it('WHOIS command in the Lookups tab routes "/whois <nick>" through onRunCommand', async () => {
    const onRunCommand = vi.fn();
    const { container } = render(<ServerSettings {...baseProps({ onRunCommand })} />);
    switchToAdvanced();
    switchAdvancedTab('Lookups');
    const whoisLabel = Array.from(container.querySelectorAll('.server-settings-cmd-label'))
      .find((el) => el.textContent === 'WHOIS');
    expect(whoisLabel).toBeDefined();
    const row = whoisLabel!.closest('.server-settings-cmd-row') as HTMLElement;
    const input = row.querySelector('input[placeholder="nick"]') as HTMLInputElement;
    expect(input).not.toBeNull();
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

  it('saving an empty password clears the entry (treated as a delete)', async () => {
    getServiceCredentialsStore().set('libera', { nickservPassword: 'old' });
    const { container } = render(<ServerSettings {...baseProps()} />);
    switchToAdvanced();
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    await userEvent.setup().clear(input);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(getServiceCredentialsStore().get('libera')).toBeNull();
  });

  // ---- Search filter -----------------------------------------------------

  it('search filters command rows by label substring (case-insensitive), across all tabs', async () => {
    const { container } = render(<ServerSettings {...baseProps()} />);
    switchToAdvanced();
    const labels = (): string[] => Array.from(container.querySelectorAll('.server-settings-cmd-label'))
      .map((el) => el.textContent ?? '');
    // Default view is the Services tab — no command rows yet (only the
    // credentials form), so labels() is empty here. Search expands the
    // view across every tab, then filters.
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
    // Query matches nothing inside HostServ (whose verbs are REQUEST/ON/OFF).
    await userEvent.setup().type(search, 'whois');
    expect(cardHeaders()).toContain('Lookups');     // hosts WHOIS
    expect(cardHeaders()).not.toContain('HostServ'); // collapsed
    expect(cardHeaders()).not.toContain('MemoServ'); // collapsed
  });

  // ---- Output capture ----------------------------------------------------

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
      // Fire the command.
      const button = row.querySelector('button[type="submit"]') as HTMLButtonElement;
      act(() => { button.click(); });
      // Engine pushes the reply into the serverLog — re-render so the
      // ref inside the capture hook sees the new entries when the
      // timeout fires.
      rerender(
        <ServerSettings {...baseProps({ onRunCommand: vi.fn(), serverLog: [replyEntry] })} />,
      );
      // Past the capture window — the NOTICE renders inline.
      act(() => { vi.advanceTimersByTime(4000); });
      expect(container.querySelector('.server-settings-cmd-output')?.textContent)
        .toMatch(/Last seen: 12 hours ago/);
    } finally {
      vi.useRealTimers();
    }
  });

});
