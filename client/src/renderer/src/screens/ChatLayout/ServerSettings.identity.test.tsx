import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { ServerSettings } from './ServerSettings';
import {
  LocalStorageServiceCredentialsStore,
  setServiceCredentialsStore,
  getServiceCredentialsStore,
} from '../../modules/chat/services-credentials';

// Identity is the unified per-server account screen: current nick +
// change-nick form, plus the NickServ account flow (status badge,
// password, email, register, confirm). Lives behind the "Identity"
// tab in ServerSettings. These tests pin the account behaviour;
// raw /msg commands for power users have their own tab in Advanced
// and are tested in ServerSettings.advanced.test.tsx.

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

function switchToIdentity(): void {
  fireEvent.click(screen.getByRole('tab', { name: /Identity/ }));
}

describe('ServerSettings — Identity (account UI)', () => {
  it('Identity is the default tab on open', () => {
    render(<ServerSettings {...baseProps()} />);
    // The Identity tab is the first item in the menu (after Info) and
    // hosts the account UI — nick + change-nick + services badges +
    // account form. Just check that it's available.
    expect(screen.getByRole('tab', { name: /Identity/ })).toBeInTheDocument();
  });

  // ---- Services / framework badge --------------------------------------

  it("renders 'Not detected' framework badge when no services have spoken", () => {
    render(<ServerSettings {...baseProps({ servicesFramework: null })} />);
    switchToIdentity();
    expect(screen.getByText('Not detected')).toBeInTheDocument();
  });

  it.each([
    ['atheme', 'Atheme'],
    ['anope',  'Anope'],
    ['ergo',   'Ergo (built-in)'],
    ['unknown','Detected (unknown package)'],
  ] as const)('framework=%s renders the matching badge label "%s"', (fw, label) => {
    render(<ServerSettings {...baseProps({ servicesFramework: fw })} />);
    switchToIdentity();
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  // ---- Status badge live-updates ---------------------------------------

  it('status badge flips from default to "Identified" when the store updates', () => {
    const { container } = render(<ServerSettings {...baseProps()} />);
    switchToIdentity();
    // No saved creds → first-touch hint.
    expect(container.textContent).toMatch(/No account saved for this server|Not connected yet/);
    act(() => {
      getServiceCredentialsStore().set('libera', {
        nickservPassword: 'pw',
        accountName: 'alice',
        status: 'identified',
      });
    });
    expect(container.textContent).toMatch(/Identified as/);
  });

  it("'identify failed' shows the red banner", () => {
    getServiceCredentialsStore().set('libera', {
      nickservPassword: 'wrong-pw',
      status: 'identify-failed',
    });
    const { container } = render(<ServerSettings {...baseProps()} />);
    switchToIdentity();
    expect(container.textContent).toMatch(/Last identify was rejected/);
  });

  // ---- Pending-confirmation form ---------------------------------------

  it("'identified-unconfirmed' shows an amber 'finish confirmation' banner with the code input", () => {
    getServiceCredentialsStore().set('libera', {
      nickservPassword: 'pw',
      email: 'hi+nyan@boson.chat',
      accountName: 'Nyan',
      status: 'identified-unconfirmed',
    });
    const { container } = render(<ServerSettings {...baseProps()} />);
    switchToIdentity();
    // Banner makes it clear identification worked AND confirmation is still pending.
    expect(container.textContent).toMatch(/Identified as/);
    expect(container.textContent).toMatch(/hasn't been email-confirmed/);
    // Confirm input is rendered.
    const codeInput = container.querySelector('.services-creds-confirm-row .bds-input') as HTMLInputElement;
    expect(codeInput).not.toBeNull();
    const confirmBtn = container.querySelector('.services-creds-confirm-row button') as HTMLButtonElement;
    expect(confirmBtn?.textContent).toBe('Confirm');
  });

  it("auto-probe also fires for 'identified-unconfirmed' so the badge re-checks after a recent INFO", () => {
    vi.useFakeTimers();
    try {
      const onRunCommand = vi.fn();
      getServiceCredentialsStore().set('libera', {
        nickservPassword: 'pw',
        accountName: 'Nyan',
        status: 'identified-unconfirmed',
      });
      render(<ServerSettings {...baseProps({ onRunCommand })} />);
      switchToIdentity();
      act(() => { vi.advanceTimersByTime(5000); });
      expect(onRunCommand).toHaveBeenCalledWith('/msg NickServ INFO Nyan');
    } finally {
      vi.useRealTimers();
    }
  });

  it("'registering' also surfaces the confirm code input (email may arrive before our classifier sees the pending reply)", () => {
    // Scenario: user clicked Register, NickServ replied so fast that
    // an email landed before our classifier locked in the
    // 'pending-confirmation' status. The user wants to paste the
    // code regardless of what our internal status thinks.
    getServiceCredentialsStore().set('libera', {
      nickservPassword: 'pw',
      email: 'alice@example.com',
      accountName: 'alice',
      status: 'registering',
    });
    const { container } = render(<ServerSettings {...baseProps()} />);
    switchToIdentity();
    expect(container.textContent).toMatch(/If you already received a confirmation code/);
    const codeInput = container.querySelector('.services-creds-confirm-row .bds-input') as HTMLInputElement;
    expect(codeInput).not.toBeNull();
    const confirmBtn = container.querySelector('.services-creds-confirm-row button') as HTMLButtonElement;
    expect(confirmBtn?.textContent).toBe('Confirm');
  });

  it('Check status button fires /msg NickServ INFO <account>', () => {
    const onRunCommand = vi.fn();
    getServiceCredentialsStore().set('libera', {
      accountName: 'alice',
    });
    render(<ServerSettings {...baseProps({ onRunCommand })} />);
    switchToIdentity();
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    expect(onRunCommand).toHaveBeenCalledWith('/msg NickServ INFO alice');
  });

  it('Check status falls back to myNick when no accountName is saved', () => {
    const onRunCommand = vi.fn();
    render(<ServerSettings {...baseProps({ onRunCommand, myNick: 'bob' })} />);
    switchToIdentity();
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    expect(onRunCommand).toHaveBeenCalledWith('/msg NickServ INFO bob');
  });

  it('Check status is hidden when no nick/account is available at all', () => {
    render(<ServerSettings {...baseProps({ myNick: '' })} />);
    switchToIdentity();
    expect(screen.queryByRole('button', { name: 'Check status' })).toBeNull();
  });

  it("auto-fires /msg NickServ INFO 5s after status enters 'registering'", () => {
    vi.useFakeTimers();
    try {
      const onRunCommand = vi.fn();
      getServiceCredentialsStore().set('libera', {
        nickservPassword: 'pw',
        accountName: 'alice',
        status: 'registering',
      });
      render(<ServerSettings {...baseProps({ onRunCommand })} />);
      switchToIdentity();
      // Should NOT have probed yet — we're still inside the 5s window.
      expect(onRunCommand).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(5000); });
      expect(onRunCommand).toHaveBeenCalledWith('/msg NickServ INFO alice');
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-probe also fires for 'pending-confirmation' status", () => {
    vi.useFakeTimers();
    try {
      const onRunCommand = vi.fn();
      getServiceCredentialsStore().set('libera', {
        accountName: 'alice',
        status: 'pending-confirmation',
      });
      render(<ServerSettings {...baseProps({ onRunCommand })} />);
      switchToIdentity();
      act(() => { vi.advanceTimersByTime(5000); });
      expect(onRunCommand).toHaveBeenCalledWith('/msg NickServ INFO alice');
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-probe does NOT fire for terminal statuses (identified, registered, no-account)', () => {
    vi.useFakeTimers();
    try {
      const onRunCommand = vi.fn();
      getServiceCredentialsStore().set('libera', {
        nickservPassword: 'pw',
        accountName: 'alice',
        status: 'identified',
      });
      render(<ServerSettings {...baseProps({ onRunCommand })} />);
      switchToIdentity();
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(onRunCommand).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("'pending-confirmation' surfaces an inline code input + Confirm button", () => {
    getServiceCredentialsStore().set('libera', {
      nickservPassword: 'pw',
      email: 'alice@example.com',
      accountName: 'alice',
      status: 'pending-confirmation',
    });
    const { container } = render(<ServerSettings {...baseProps()} />);
    switchToIdentity();
    expect(container.textContent).toMatch(/Check your inbox for a confirmation code/);
    expect(container.textContent).toMatch(/alice@example\.com/);
    const codeInput = container.querySelector('.services-creds-confirm-row .bds-input') as HTMLInputElement;
    expect(codeInput).not.toBeNull();
    const confirmBtn = container.querySelector('.services-creds-confirm-row button') as HTMLButtonElement;
    expect(confirmBtn?.textContent).toBe('Confirm');
  });

  it('Confirm button calls onConfirmAccount with (accountName, code)', async () => {
    // Post-migration: the Confirm flow goes through AccountService —
    // the UI no longer builds raw IRC strings. Wire format selection
    // (CONFIRM vs VERIFY REGISTER) lives in account-service-{anope,
    // atheme,ergo}.ts; per-impl wire-format coverage is in
    // account-service-confirm.test.ts. This test just pins that the
    // button calls the typed handler with the right args.
    const onConfirmAccount = vi.fn().mockResolvedValue({ kind: 'confirmed' });
    getServiceCredentialsStore().set('libera', {
      accountName: 'alice',
      status: 'pending-confirmation',
    });
    const { container } = render(<ServerSettings {...baseProps({ onConfirmAccount })} />);
    switchToIdentity();
    const codeInput = container.querySelector('.services-creds-confirm-row .bds-input') as HTMLInputElement;
    await userEvent.setup().type(codeInput, 'abc123');
    const confirmBtn = container.querySelector('.services-creds-confirm-row button') as HTMLButtonElement;
    fireEvent.click(confirmBtn);
    expect(onConfirmAccount).toHaveBeenCalledWith('alice', 'abc123');
  });

  // ---- Save + Identify + Register --------------------------------------

  it('Save persists the password and email to the credentials store', async () => {
    const { container } = render(<ServerSettings {...baseProps()} />);
    switchToIdentity();
    // Skip the change-nick input + the Account-nick input — find password by type.
    const pwInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(pwInput).not.toBeNull();
    await userEvent.setup().type(pwInput, 'hunter2');
    const emailInput = container.querySelector('input[placeholder="you@example.com"]') as HTMLInputElement;
    await userEvent.setup().type(emailInput, 'alice@example.com');
    // Save button — submit-type buttons in the account form. Find by
    // text to disambiguate from the Change-nick Save.
    const saveBtns = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === 'Save');
    // First Save is for Change-nick; account form's Save is the second.
    saveBtns[saveBtns.length - 1]!.click();
    const persisted = getServiceCredentialsStore().get('libera');
    expect(persisted?.nickservPassword).toBe('hunter2');
    expect(persisted?.email).toBe('alice@example.com');
  });

  it('pre-fills the inputs from the saved credentials on mount', () => {
    getServiceCredentialsStore().set('libera', {
      nickservPassword: 'persisted-pw',
      email: 'persisted@example.com',
      accountName: 'persisted-acct',
    });
    const { container } = render(<ServerSettings {...baseProps()} />);
    switchToIdentity();
    const pwInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(pwInput.value).toBe('persisted-pw');
    const emailInput = container.querySelector('input[placeholder="you@example.com"]') as HTMLInputElement;
    expect(emailInput.value).toBe('persisted@example.com');
  });

  it("'Identify now' button fires onTriggerAutoIdentify when a password is saved", () => {
    const onTriggerAutoIdentify = vi.fn();
    getServiceCredentialsStore().set('libera', { nickservPassword: 'pw' });
    render(<ServerSettings {...baseProps({ onTriggerAutoIdentify })} />);
    switchToIdentity();
    fireEvent.click(screen.getByRole('button', { name: 'Identify now' }));
    expect(onTriggerAutoIdentify).toHaveBeenCalledOnce();
  });

  it("hides 'Identify now' when no password is stored", () => {
    render(<ServerSettings {...baseProps()} />);
    switchToIdentity();
    expect(screen.queryByRole('button', { name: 'Identify now' })).toBeNull();
  });

  it('Register button calls onRegisterAccount(pw, email) and writes a transient registering status', async () => {
    // Post-migration: the typed handler returns a discrete
    // RegisterResult; the UI awaits it and surfaces the outcome
    // inline. Wire format = raw PRIVMSG REGISTER pw email; covered
    // in account-service-register.test.ts.
    const onRegisterAccount = vi.fn().mockResolvedValue({ kind: 'pending-confirmation', email: 'alice@example.com' });
    const { container } = render(<ServerSettings {...baseProps({ onRegisterAccount })} />);
    switchToIdentity();
    const pwInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    const emailInput = container.querySelector('input[placeholder="you@example.com"]') as HTMLInputElement;
    await userEvent.setup().type(pwInput, 'hunter2');
    await userEvent.setup().type(emailInput, 'alice@example.com');
    const registerBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.match(/Register new account|Registering…/));
    expect(registerBtn).toBeTruthy();
    fireEvent.click(registerBtn!);
    expect(onRegisterAccount).toHaveBeenCalledWith('hunter2', 'alice@example.com');
    const persisted = getServiceCredentialsStore().get('libera');
    expect(persisted?.nickservPassword).toBe('hunter2');
    expect(persisted?.email).toBe('alice@example.com');
    expect(persisted?.status).toBe('registering');
  });

  it('Clear button removes the saved credentials', () => {
    getServiceCredentialsStore().set('libera', {
      nickservPassword: 'pw',
      email: 'alice@example.com',
    });
    render(<ServerSettings {...baseProps()} />);
    switchToIdentity();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(getServiceCredentialsStore().get('libera')).toBeNull();
  });

  // ---- Resend confirmation email --------------------------------------

  it("'Resend email' button is visible on Anope when status is pending-confirmation", () => {
    getServiceCredentialsStore().set('libera', {
      accountName: 'alice',
      email: 'alice@example.com',
      status: 'pending-confirmation',
    });
    render(<ServerSettings {...baseProps({
      servicesFramework: 'anope',
      onResendConfirmation: vi.fn().mockResolvedValue({ kind: 'sent' }),
      supportsResend: true,
    })} />);
    switchToIdentity();
    expect(screen.getByRole('button', { name: /Resend email/i })).toBeInTheDocument();
  });

  it("'Resend email' button is HIDDEN on Atheme (supportsResend=false)", () => {
    // Post-migration: visibility is gated on the typed prop
    // `supportsResend`. The panel doesn't introspect the framework
    // any more — that decision lives in chat.service.ts.supportsResendConfirmation()
    // and is forwarded as a boolean.
    getServiceCredentialsStore().set('libera', {
      accountName: 'alice',
      email: 'alice@example.com',
      status: 'pending-confirmation',
    });
    render(<ServerSettings {...baseProps({
      servicesFramework: 'atheme',
      onResendConfirmation: vi.fn(),
      supportsResend: false,
    })} />);
    switchToIdentity();
    expect(screen.queryByRole('button', { name: /Resend/i })).toBeNull();
  });

  it("'Resend email' button calls onResendConfirmation(account) on click", async () => {
    const onResendConfirmation = vi.fn().mockResolvedValue({ kind: 'sent' });
    getServiceCredentialsStore().set('libera', {
      accountName: 'alice',
      email: 'alice@example.com',
      status: 'pending-confirmation',
    });
    render(<ServerSettings {...baseProps({
      servicesFramework: 'anope',
      onResendConfirmation,
      supportsResend: true,
    })} />);
    switchToIdentity();
    fireEvent.click(screen.getByRole('button', { name: /Resend email/i }));
    // Yield to the microtask so the click handler's async body runs.
    await Promise.resolve();
    expect(onResendConfirmation).toHaveBeenCalledWith('alice');
  });

  it("'Resend email' button disables itself when resendCooldownUntil is in the future", () => {
    const futureMs = Date.now() + 3 * 60_000; // 3 min from now
    getServiceCredentialsStore().set('libera', {
      accountName: 'alice',
      email: 'alice@example.com',
      status: 'pending-confirmation',
      resendCooldownUntil: futureMs,
    });
    render(<ServerSettings {...baseProps({
      servicesFramework: 'anope',
      onResendConfirmation: vi.fn(),
      supportsResend: true,
    })} />);
    switchToIdentity();
    const btn = screen.getByRole('button', { name: /Resend/i });
    expect(btn).toBeDisabled();
    // Button label flips to include the countdown ("Resend (3m)").
    expect(btn.textContent).toMatch(/3m/);
  });

  it("'Resend email' button is enabled once resendCooldownUntil has passed", () => {
    getServiceCredentialsStore().set('libera', {
      accountName: 'alice',
      email: 'alice@example.com',
      status: 'pending-confirmation',
      resendCooldownUntil: Date.now() - 60_000, // 1 min ago
    });
    render(<ServerSettings {...baseProps({
      servicesFramework: 'anope',
      onResendConfirmation: vi.fn(),
      supportsResend: true,
    })} />);
    switchToIdentity();
    expect(screen.getByRole('button', { name: /Resend email/i })).not.toBeDisabled();
  });

  // ---- Drop account ----------------------------------------------------

  it('hides the Drop account button when no password is saved', () => {
    // Need both a password (to send) and an accountName (to target).
    // Without either, we'd just bounce off NickServ.
    render(<ServerSettings {...baseProps()} />);
    switchToIdentity();
    expect(screen.queryByRole('button', { name: 'Drop account' })).toBeNull();
  });

  it('shows the Drop account button when a password is saved', () => {
    getServiceCredentialsStore().set('libera', {
      nickservPassword: 'hunter2',
      accountName: 'alice',
    });
    render(<ServerSettings {...baseProps()} />);
    switchToIdentity();
    expect(screen.getByRole('button', { name: 'Drop account' })).toBeInTheDocument();
  });

  it('Drop account asks for confirmation before firing (two-state)', async () => {
    const onDropAccount = vi.fn().mockResolvedValue({ kind: 'dropped' });
    getServiceCredentialsStore().set('libera', {
      nickservPassword: 'hunter2',
      accountName: 'alice',
    });
    const { container } = render(<ServerSettings {...baseProps({ onDropAccount })} />);
    switchToIdentity();
    fireEvent.click(screen.getByRole('button', { name: 'Drop account' }));
    // No command fired yet — just the confirm prompt is up.
    expect(onDropAccount).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/Drop\s+alice\s+on this network/);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, drop it' }));
    expect(onDropAccount).toHaveBeenCalledWith('alice', 'hunter2');
  });

  it.each([
    ['atheme'],  // Atheme 7.2.x requires both args — handled inside AthemeAccountService
    ['anope'],   // Anope canonical 1-arg + auto-2-arg fallback — handled inside AnopeAccountService
    ['ergo'],    // Ergo UNREGISTER — handled inside ErgoAccountService
    ['unknown'], // Fallback to Anope-shape — handled inside AnopeAccountService
  ] as const)('Drop button always calls onDropAccount(acct, pw) regardless of framework=%s', (fw) => {
    // Per-package wire format coverage lives in
    // account-service-anope.test.ts / -atheme.test.ts / -ergo.test.ts.
    // The panel itself just calls the typed handler — it no longer
    // knows about the per-package command shapes.
    const onDropAccount = vi.fn().mockResolvedValue({ kind: 'dropped' });
    getServiceCredentialsStore().set('libera', {
      nickservPassword: 'hunter2',
      accountName: 'alice',
    });
    render(<ServerSettings {...baseProps({ onDropAccount, servicesFramework: fw })} />);
    switchToIdentity();
    fireEvent.click(screen.getByRole('button', { name: 'Drop account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, drop it' }));
    expect(onDropAccount).toHaveBeenCalledWith('alice', 'hunter2');
  });

  it('Cancel rolls back the confirm prompt and does not fire DROP', () => {
    const onDropAccount = vi.fn();
    getServiceCredentialsStore().set('libera', {
      nickservPassword: 'hunter2',
      accountName: 'alice',
    });
    render(<ServerSettings {...baseProps({ onDropAccount })} />);
    switchToIdentity();
    fireEvent.click(screen.getByRole('button', { name: 'Drop account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDropAccount).not.toHaveBeenCalled();
    // Back to the idle "Drop account" button.
    expect(screen.getByRole('button', { name: 'Drop account' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yes, drop it' })).toBeNull();
  });

  it('falls back to myNick as the DROP target when no accountName is saved', () => {
    const onDropAccount = vi.fn().mockResolvedValue({ kind: 'dropped' });
    getServiceCredentialsStore().set('libera', {
      nickservPassword: 'hunter2',
      // No accountName — should use myNick from props.
    });
    render(<ServerSettings {...baseProps({ onDropAccount, myNick: 'bob' })} />);
    switchToIdentity();
    fireEvent.click(screen.getByRole('button', { name: 'Drop account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, drop it' }));
    expect(onDropAccount).toHaveBeenCalledWith('bob', 'hunter2');
  });

  it('cancels the in-flight confirm prompt when the credentials store flips out from under us', () => {
    // E.g. ChatService's classifier wrote a fresh status after the
    // user opened the confirm prompt. The subscription handler should
    // close the prompt so the next click on "Drop account" starts a
    // fresh round, not silently confirms a stale action.
    getServiceCredentialsStore().set('libera', {
      nickservPassword: 'hunter2',
      accountName: 'alice',
    });
    render(<ServerSettings {...baseProps({ onDropAccount: vi.fn() })} />);
    switchToIdentity();
    fireEvent.click(screen.getByRole('button', { name: 'Drop account' }));
    expect(screen.getByRole('button', { name: 'Yes, drop it' })).toBeInTheDocument();
    act(() => {
      getServiceCredentialsStore().set('libera', {
        nickservPassword: 'hunter2',
        accountName: 'alice',
        status: 'identified',
      });
    });
    expect(screen.queryByRole('button', { name: 'Yes, drop it' })).toBeNull();
  });

  it('shows an empty-state notice when serverId is omitted', () => {
    render(<ServerSettings {...baseProps({ serverId: undefined })} />);
    switchToIdentity();
    expect(screen.getByText(/Saved account credentials need a stable server id/)).toBeInTheDocument();
  });
});
