// Per-connection ChanServ state: which package the network runs, what it said
// about each channel (cached), and the actions the channel settings UI runs.
//
// Lives next to a ChatService (one per IRC connection), which feeds it the
// detection signals and IRC events. The UI subscribes; nothing here touches
// the DOM.
import type { IrcEvent } from '../engine/engine.types';
import { getChanServAdapter, type ChanServAdapter } from './adapters';
import type {
  AccessEntry, ChanRole, ChanServCapabilities, ChanServDialect, ChanServError, ChanServResult, ChannelRegistration,
} from './chanserv.types';
import { detectChanServDialect, type DialectSignals } from './detect';
import { ChanServRunner, type RunnerOptions, type RunnerSession } from './runner';
import { sameName } from './text';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ChannelServicesState {
  infoStatus: LoadStatus;
  info?: ChannelRegistration;
  infoError?: ChanServError;
  accessStatus: LoadStatus;
  access?: AccessEntry[];
  accessError?: ChanServError;
  fetchedAt?: number;
}

export interface ChanServState {
  dialect: ChanServDialect | null;
  label: string | null;
  caps: ChanServCapabilities | null;
  // false: the network has no channel service (401 on ChanServ), or it is
  // switched off (Ergo with channel registration disabled).
  present: boolean | null;
  absentReason?: 'no-service' | 'disabled';
  channels: Readonly<Record<string, ChannelServicesState>>;
  // Channels someone offered us ownership of (Ergo TRANSFER), awaiting accept.
  offers: readonly string[];
}

export interface ChanServDeps {
  signals(): DialectSignals;
  myAccount(): string | undefined;
  now?: () => number;
}

const STALE_MS = 10 * 60_000;
const EMPTY_CHANNEL: ChannelServicesState = { infoStatus: 'idle', accessStatus: 'idle' };

const key = (channel: string): string => channel.toLowerCase();

export class ChanServController {
  private readonly runner: ChanServRunner;
  private adapter: ChanServAdapter | null = null;
  private state: ChanServState = { dialect: null, label: null, caps: null, present: null, channels: {}, offers: [] };
  private readonly listeners = new Set<(s: ChanServState) => void>();
  private readonly waiting = new Set<string>();
  private readonly seenLines: string[] = [];
  private readonly now: () => number;
  private disposed = false;
  private readonly eventListeners = new Set<(e: IrcEvent) => void>();

  // `send` PRIVMSGs the service. Events arrive through handleEvent (the
  // chat service forwards its session's), so this never subscribes to the
  // session itself.
  constructor(send: (target: string, message: string) => void, private readonly deps: ChanServDeps, opts: RunnerOptions = {}) {
    const session: RunnerSession = {
      privmsg: send,
      onEvent: (fn) => { this.eventListeners.add(fn); return () => { this.eventListeners.delete(fn); }; },
    };
    this.runner = new ChanServRunner(session, opts);
    this.now = deps.now ?? Date.now;
    this.updateSignals();
  }

  // Every IRC event of the connection, in order.
  handleEvent(e: IrcEvent): void {
    if (this.disposed) return;
    for (const fn of [...this.eventListeners]) fn(e);
    this.noteEvent(e);
  }

  getState(): ChanServState { return this.state; }

  subscribe(fn: (s: ChanServState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }

  channel(channel: string): ChannelServicesState {
    return this.state.channels[key(channel)] ?? EMPTY_CHANNEL;
  }

  // Background lookups own the service's replies while they run; the chat
  // service keeps those out of the Server log.
  claims(e: IrcEvent): boolean { return this.runner.claims(e); }

  // Resolves when no ChanServ exchange is queued or running.
  idle(): Promise<void> { return this.runner.idle(); }

  dispose(): void {
    this.disposed = true;
    this.eventListeners.clear();
    this.listeners.clear();
  }

  // Re-run detection (the engine verdict, 004 or 005 changed).
  updateSignals(): void {
    const s = this.deps.signals();
    const dialect = detectChanServDialect({ ...s, chanservLines: this.seenLines });
    if (dialect === this.state.dialect) return;
    this.adapter = dialect ? getChanServAdapter(dialect) : null;
    this.patch({
      dialect,
      label: this.adapter?.label ?? null,
      caps: this.adapter?.caps ?? null,
      present: dialect === 'q' ? false : null,
      ...(dialect === 'q' ? {} : { absentReason: undefined }),
      channels: {},
    });
    if (this.adapter) for (const ch of this.waiting) void this.refresh(ch);
    this.waiting.clear();
  }

  // ---- reads ----------------------------------------------------------------

  // Fetch INFO unless we have a fresh answer (or a lookup running).
  ensureInfo(channel: string): void {
    const c = this.channel(channel);
    if (c.infoStatus === 'loading') return;
    if (c.infoStatus === 'ready' && c.fetchedAt !== undefined && this.now() - c.fetchedAt < STALE_MS) return;
    if (c.infoStatus === 'error' && c.fetchedAt !== undefined && this.now() - c.fetchedAt < STALE_MS) return;
    void this.refresh(channel);
  }

  async refresh(channel: string): Promise<void> {
    const a = this.adapter;
    if (!a) { this.waiting.add(key(channel)); return; }
    if (!a.caps.info || this.state.present === false) return;
    this.patchChannel(channel, { infoStatus: 'loading' });
    const r = await this.runner.run(a.serviceNick, a.info(channel));
    if (this.disposed || a !== this.adapter) return;
    if (r.kind === 'info') {
      let info = r.info;
      if (info.registered && a.readSettings) {
        const extra = await this.runner.run(a.serviceNick, a.readSettings(channel));
        if (extra.kind === 'info') info = { ...info, values: { ...info.values, ...extra.info.values } };
      }
      if (this.state.present !== true) this.patch({ present: true });
      this.patchChannel(channel, { infoStatus: 'ready', info, infoError: undefined, fetchedAt: this.now() });
      return;
    }
    if (r.code === 'no-service' || r.code === 'disabled') {
      this.patch({ present: false, absentReason: r.code === 'disabled' ? 'disabled' : 'no-service' });
    } else if (r.code !== 'timeout' && r.code !== 'unreadable' && this.state.present !== true) {
      // Any recognised answer means someone is there.
      this.patch({ present: true });
    }
    this.patchChannel(channel, { infoStatus: 'error', infoError: r, fetchedAt: this.now() });
  }

  async loadAccess(channel: string): Promise<void> {
    const a = this.adapter;
    if (!a?.listAccess) return;
    this.patchChannel(channel, { accessStatus: 'loading' });
    const r = await this.runner.run(a.serviceNick, a.listAccess(channel));
    if (this.disposed || a !== this.adapter) return;
    if (r.kind === 'access') this.patchChannel(channel, { accessStatus: 'ready', access: r.entries, accessError: undefined });
    else this.patchChannel(channel, { accessStatus: 'error', accessError: r });
  }

  // ---- actions --------------------------------------------------------------

  async register(channel: string, description?: string): Promise<ChanServResult> {
    const a = this.adapter;
    if (!a?.register) return unsupported();
    if (!this.deps.myAccount()) return { kind: 'error', code: 'not-logged-in', lines: [] };
    const r = await this.runner.run(a.serviceNick, a.register(channel, description));
    if (r.kind === 'done' || (r.kind === 'error' && r.code === 'already-registered')) void this.refresh(channel);
    return r;
  }

  async transfer(channel: string, account: string): Promise<ChanServResult> {
    const a = this.adapter;
    if (!a?.transfer) return unsupported();
    const r = await this.runner.run(a.serviceNick, a.transfer(channel, account.trim(), this.deps.myAccount() ?? ''));
    if (r.kind === 'done') { void this.refresh(channel); void this.loadAccess(channel); }
    return r;
  }

  async acceptTransfer(channel: string): Promise<ChanServResult> {
    const a = this.adapter;
    if (!a?.acceptTransfer) return unsupported();
    const r = await this.runner.run(a.serviceNick, a.acceptTransfer(channel));
    if (r.kind === 'done' || r.kind === 'error') {
      this.patch({ offers: this.state.offers.filter((o) => !sameName(o, channel)) });
    }
    if (r.kind === 'done') void this.refresh(channel);
    return r;
  }

  dismissOffer(channel: string): void {
    this.patch({ offers: this.state.offers.filter((o) => !sameName(o, channel)) });
  }

  async unregister(channel: string): Promise<ChanServResult> {
    const a = this.adapter;
    if (!a?.unregister) return unsupported();
    const r = await this.runner.run(a.serviceNick, a.unregister(channel));
    if (r.kind === 'done') {
      this.patchChannel(channel, { access: undefined, accessStatus: 'idle' });
      void this.refresh(channel);
    }
    return r;
  }

  async setAccess(channel: string, account: string, role: ChanRole | null, previous?: ChanRole | null): Promise<ChanServResult> {
    const a = this.adapter;
    if (!a?.setAccess) return unsupported();
    const r = await this.runner.run(a.serviceNick, a.setAccess(channel, account.trim(), role, previous));
    if (r.kind === 'done') void this.loadAccess(channel);
    return r;
  }

  async setOption(channel: string, option: string, value: boolean | string): Promise<ChanServResult> {
    const a = this.adapter;
    if (!a?.setOption) return unsupported();
    const r = await this.runner.run(a.serviceNick, a.setOption(channel, option, value));
    if (r.kind === 'done') {
      // Reflect it at once; the refresh confirms.
      const c = this.channel(channel);
      if (c.info) {
        const info = typeof value === 'string'
          ? { ...c.info, values: { ...c.info.values, [option]: value } }
          : { ...c.info, options: { ...c.info.options, [option]: value } };
        this.patchChannel(channel, { info });
      }
      void this.refresh(channel);
    }
    return r;
  }

  // ---- events ---------------------------------------------------------------

  private noteEvent(e: IrcEvent): void {
    if (this.disposed) return;
    const a = this.adapter;
    if ((e.Kind === 'NOTICE' || e.Kind === 'PRIVMSG') && sameName(e.From, a?.serviceNick ?? 'ChanServ')) {
      if (!this.state.dialect && this.seenLines.length < 40) {
        this.seenLines.push(e.Message ?? '');
        this.updateSignals();
      }
      const offered = a?.transferOffer?.(e.Message ?? '');
      if (offered && !this.state.offers.some((o) => sameName(o, offered))) this.patch({ offers: [...this.state.offers, offered] });
      return;
    }
    // Logging in or out changes what INFO shows (and whether we're founder).
    if (e.Kind === '900' || e.Kind === '901') { this.invalidateAll(); return; }
    // Founder mode (+q) or registered mode (+r, Unreal/InspIRCd) moving on a
    // channel usually means its registration changed.
    if (e.Kind === 'MODE' && e.Target && (e.Target.startsWith('#') || e.Target.startsWith('&'))) {
      const modes = e.Args?.[0] ?? '';
      if (/[qr]/.test(modes) && this.state.channels[key(e.Target)]?.infoStatus === 'ready') void this.refresh(e.Target);
    }
  }

  private invalidateAll(): void {
    const channels: Record<string, ChannelServicesState> = {};
    for (const [k, v] of Object.entries(this.state.channels)) channels[k] = { ...v, fetchedAt: undefined };
    this.patch({ channels });
    for (const [k, v] of Object.entries(channels)) if (v.infoStatus === 'ready' || v.infoStatus === 'error') void this.refresh(k);
  }

  private patchChannel(channel: string, p: Partial<ChannelServicesState>): void {
    const k = key(channel);
    const prev = this.state.channels[k] ?? EMPTY_CHANNEL;
    this.patch({ channels: { ...this.state.channels, [k]: { ...prev, ...p } } });
  }

  private patch(p: Partial<ChanServState>): void {
    this.state = { ...this.state, ...p };
    for (const fn of this.listeners) fn(this.state);
  }
}

const unsupported = (): ChanServResult => ({ kind: 'error', code: 'unsupported', lines: [] });
