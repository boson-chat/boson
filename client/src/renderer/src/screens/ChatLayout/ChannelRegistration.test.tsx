import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/preact';
import { ChanServController, type ChanServState } from '../../modules/chanserv';
import type { IrcEvent } from '../../modules/engine/engine.types';
import { ChannelRegistration } from './ChannelRegistration';

// A controller over a scripted ChanServ (Ergo replies by default).
function setup(script: (body: string) => string[], opts: { account?: string; version?: string; framework?: 'anope' | 'atheme' } = {}) {
  const sent: string[] = [];
  let ctl!: ChanServController;
  ctl = new ChanServController((_t, body) => {
    sent.push(body);
    const lines = script(body);
    setTimeout(() => { for (const l of lines) ctl.handleEvent({ Kind: 'NOTICE', From: 'ChanServ', Target: 'ada', Message: l, Raw: '' } as IrcEvent); }, 5);
  }, {
    signals: () => ({ version: opts.version ?? 'ergo-2.19.1', framework: opts.framework ?? null }),
    myAccount: () => ('account' in opts ? opts.account : 'ada'),
  }, { quietMs: 20 });
  return { ctl, sent };
}

function View({ ctl, rank = 5, account = 'ada' }: { ctl: ChanServController; rank?: number; account?: string }) {
  const state: ChanServState = ctl.getState();
  return <ChannelRegistration channel="#dev" ctl={ctl} state={state} myRank={rank} myAccount={account} policy={null} />;
}

async function flush(ms = 200): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

afterEach(() => { vi.useRealTimers(); });

const REGISTERED = ['Channel #dev is registered', 'Founder: ada', 'Registered at: Mon, 02 Nov 2026 10:00:00 UTC'];

describe('ChannelRegistration', () => {
  it('offers Register to a signed-in op of an unregistered channel, and explains guests', async () => {
    vi.useFakeTimers();
    const { ctl } = setup(() => ['Channel #dev is not registered']);
    const { rerender } = render(<View ctl={ctl} />);
    await flush();
    rerender(<View ctl={ctl} />);
    expect(screen.getByText('Not registered')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Register #dev' }) as HTMLButtonElement).disabled).toBe(false);
    rerender(<View ctl={ctl} account="" />);
    expect((screen.getByRole('button', { name: 'Register #dev' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Sign in to an account to register channels.')).toBeTruthy();
    rerender(<View ctl={ctl} rank={1} />);
    expect(screen.getByText('Only channel operators (@) can register it.')).toBeTruthy();
  });

  it('shows a ChanServ refusal in plain language', async () => {
    vi.useFakeTimers();
    const { ctl } = setup((b) => b.startsWith('REGISTER') ? ['You have already registered the maximum number of channels; try dropping some with /CS UNREGISTER'] : ['Channel #dev is not registered']);
    const { rerender } = render(<View ctl={ctl} />);
    await flush();
    rerender(<View ctl={ctl} />);
    fireEvent.click(screen.getByRole('button', { name: 'Register #dev' }));
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('as many channels as this server allows');
  });

  it('founder sees roles, protection and ownership; unregister needs the typed name', async () => {
    vi.useFakeTimers();
    const { ctl, sent } = setup((b) => {
      if (b === 'INFO #dev') return REGISTERED;
      if (b.startsWith('GET')) return ['The stored channel history setting is: default'];
      if (b === 'AMODE #dev') return ['Channel #dev has 1 persistent modes set', 'Account nova receives mode +o'];
      if (b === 'UNREGISTER #dev') return ['To confirm, run this command: /CS UNREGISTER #dev 42'];
      if (b === 'UNREGISTER #dev 42') return ['Channel #dev is now unregistered'];
      return [];
    });
    const { rerender } = render(<View ctl={ctl} />);
    await flush();
    rerender(<View ctl={ctl} />);
    await flush();
    rerender(<View ctl={ctl} />);
    expect(screen.getByText('Registered')).toBeTruthy();
    expect(screen.getByLabelText('Role for nova')).toBeTruthy();
    expect(screen.getByLabelText('Message history')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Unregister #dev…' }));
    const go = screen.getByRole('button', { name: 'Unregister' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText(/to confirm/), { target: { value: '#DEV' } });
    expect((screen.getByRole('button', { name: 'Unregister' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Unregister' }));
    await flush();
    expect(sent).toContain('UNREGISTER #dev 42');
    expect(screen.getByText('#dev is no longer registered.')).toBeTruthy();
  });

  it('a non-founder op gets roles but not ownership', async () => {
    vi.useFakeTimers();
    const { ctl } = setup((b) => b === 'INFO #dev' ? REGISTERED : b === 'AMODE #dev' ? ['Channel #dev has 0 persistent modes set'] : ['The stored channel history setting is: on']);
    const { rerender } = render(<View ctl={ctl} account="kestrel" rank={3} />);
    await flush();
    rerender(<View ctl={ctl} account="kestrel" rank={3} />);
    expect(screen.getByText('Roles')).toBeTruthy();
    expect(screen.queryByText('Ownership')).toBeNull();
  });

  it('a plain member sees only the status', async () => {
    vi.useFakeTimers();
    const { ctl } = setup(() => REGISTERED);
    const { rerender } = render(<View ctl={ctl} account="pixel" rank={1} />);
    await flush();
    rerender(<View ctl={ctl} account="pixel" rank={1} />);
    expect(screen.getByText('Registered')).toBeTruthy();
    expect(screen.queryByText('Roles')).toBeNull();
  });
});
