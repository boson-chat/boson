import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { ServerSettings } from './ServerSettings';
import {
  LocalStorageServiceCredentialsStore,
  setServiceCredentialsStore,
  getServiceCredentialsStore,
} from '../../modules/chat/services-credentials';

// The Operators tab is owner-only (gated on directoryEntry + onSaveProfile,
// the same signal as Edit). On Anope it drives OperServ OPER live and gates
// the controls on isOper; on Atheme/Ergo it generates a config block.

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
afterEach(() => { setServiceCredentialsStore(savedStore); });

function ownerProps(overrides: Partial<Parameters<typeof ServerSettings>[0]> = {}) {
  return {
    serverDisplayName: 'boson',
    myNick: 'Nyan2',
    serverInfo: {},
    serverLog: [],
    onClearServerLog: vi.fn(),
    onClose: vi.fn(),
    serverId: 'srv-boson',
    servicesFramework: 'anope',
    onRunCommand: vi.fn(),
    // Owner context — presence of these makes Edit + Operators tabs visible.
    directoryEntry: {
      serverId: 'srv-boson', name: 'boson', description: '', tags: [], languages: [], isNsfw: false,
    },
    onSaveProfile: vi.fn(async () => {}),
    ...overrides,
  } as Parameters<typeof ServerSettings>[0];
}

const operTab = () => screen.getByRole('tab', { name: /Operators/ });
const rowFor = (container: Element, label: string): HTMLElement => {
  const el = Array.from(container.querySelectorAll('.server-settings-cmd-label'))
    .find((n) => n.textContent === label);
  return el!.closest('.server-settings-cmd-row')!.parentElement as HTMLElement;
};

describe('ServerSettings — Operators tab gating', () => {
  it('is hidden when the viewer is not the owner', () => {
    const p = ownerProps({ directoryEntry: undefined, onSaveProfile: undefined });
    render(<ServerSettings {...p} />);
    expect(screen.queryByRole('tab', { name: /Operators/ })).toBeNull();
  });

  it('is shown for the owner', () => {
    const p = ownerProps();
    render(<ServerSettings {...p} />);
    expect(operTab()).toBeInTheDocument();
  });
});

describe('ServerSettings — Operators (Anope, live)', () => {
  it('shows the Operator badge and enables controls when isOper', () => {
    const p = ownerProps({ isOper: true });
    const { container } = render(<ServerSettings {...p} />);
    fireEvent.click(operTab());
    expect(screen.getByText('Operator')).toBeInTheDocument();
    // List is nullary — its only disable condition is the isOper gate, so it
    // reflects the gate cleanly (Add/Remove also disable on empty inputs).
    expect(rowFor(container, 'List operators').querySelector('button')).not.toBeDisabled();
  });

  it('shows a warning + disables controls when not an operator', () => {
    const p = ownerProps({ isOper: false });
    const { container } = render(<ServerSettings {...p} />);
    fireEvent.click(operTab());
    expect(screen.getByText('Not a network operator')).toBeInTheDocument();
    // The gate (onRunCommand withheld) disables every control regardless of
    // input — List has no inputs, so it isolates the gate.
    expect(rowFor(container, 'List operators').querySelector('button')).toBeDisabled();
  });

  it('routes Add through onRunCommand as OperServ OPER ADD <account> <type>', async () => {
    vi.useFakeTimers();
    try {
      const onRunCommand = vi.fn();
      const p = ownerProps({ isOper: true, onRunCommand });
      const { container } = render(<ServerSettings {...p} />);
      fireEvent.click(operTab());
      const row = rowFor(container, 'Add operator');
      const inputs = row.querySelectorAll('input');
      act(() => {
        fireEvent.input(inputs[0]!, { target: { value: 'nyan' } });
        fireEvent.input(inputs[1]!, { target: { value: 'Services Operator' } });
      });
      act(() => { fireEvent.click(row.querySelector('button[type="submit"]') as HTMLButtonElement); });
      expect(onRunCommand).toHaveBeenCalledWith('/msg OperServ OPER ADD nyan Services Operator');
      act(() => { vi.advanceTimersByTime(4000); }); // flush the capture timer
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ServerSettings — Operators (Atheme/Ergo, config)', () => {
  it('generates an operator{} block and never sends a command', async () => {
    const onRunCommand = vi.fn();
    const p = ownerProps({ servicesFramework: 'atheme', onRunCommand });
    const { container } = render(<ServerSettings {...p} />);
    fireEvent.click(operTab());
    // No live capturing controls in config mode.
    expect(screen.queryByText('Add operator')).toBeNull();
    const inputs = container.querySelectorAll('input');
    await userEvent.setup().type(inputs[0]! as HTMLInputElement, 'alice');
    const block = container.querySelector('.server-settings-cmd-output')!.textContent ?? '';
    expect(block).toContain('operator "alice"');
    expect(block).toContain('operclass');
    expect(onRunCommand).not.toHaveBeenCalled();
  });
});
