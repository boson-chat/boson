// Desktop notifications. The chat service calls notify() for every notifiable
// live message (mention / DM / plain) with full context, including whether
// it's in the conversation the user has open; we decide whether to raise an
// OS notification from the user's settings and whether they can see it:
//
//   - window focused            → never (the in-app badges cover it)
//   - the open conversation     → not while the window is on screen, even if
//                                 another app has focus (it's right there)
//   - window minimised / hidden → everything the settings allow
//
// Window focus comes from the desktop shell's native window events when it
// has them (bosonWindow.attention), else from DOM focus/blur; a hidden page
// (visibilitychange: minimised, app hidden) always counts as not visible.
// Clicking a banner focuses the window and switches to the originating
// server + channel.
import {
  getChannelLevel,
  getNotificationSettings,
  type ChannelLevel,
  type NotificationSettings,
} from './notifications.store';
import { getNotificationFeed } from '../notifications/feed';
import { chime } from '../notifications/chime';
import { getWindowBridge, type WindowAttention } from '../../shared/window-controls';

export type NotifyKind = 'mention' | 'dm' | 'message';

export interface NotifyEvent {
  serverId: string;
  serverName?: string;
  channel: string; // '#chan' for a channel mention; the sender's nick for a DM
  from: string;
  text: string;
  kind: NotifyKind;
  // The message is in the conversation currently open on screen: the
  // foreground server's active channel. Set by the chat service, which knows.
  open?: boolean;
}

// Pure decision: should this event raise an OS notification right now?
// Whether this kind of message is wanted at all: the type switches and the
// conversation's own level (All / Mentions / Nothing).
function wanted(ev: NotifyEvent, s: NotificationSettings, level: ChannelLevel): boolean {
  if (level === 'nothing') return false;
  if (ev.kind === 'dm') return s.directMessages;
  if (ev.kind === 'mention') return s.mentions;
  return s.allMessages || level === 'all';
}

// A system notification (OS banner): only while Boson isn't focused.
export function shouldNotify(ev: NotifyEvent, s: NotificationSettings, att: WindowAttention, level: ChannelLevel = 'mentions'): boolean {
  if (!s.enabled) return false;
  if (att.focused) return false; // you're looking — the badge is enough
  if (ev.open && att.visible) return false; // it's on screen in front of you
  return wanted(ev, s, level);
}

// An in-app toast: for anything somewhere you're not looking.
export function shouldToast(ev: NotifyEvent, s: NotificationSettings, level: ChannelLevel = 'mentions'): boolean {
  if (!s.inApp) return false;
  if (ev.open) return false; // the conversation you're looking at
  return wanted(ev, s, level);
}

// Strip IRC formatting / control codes (bold, color, etc.) and collapse runs of
// whitespace, then clamp to a banner-friendly length.
function clean(s: string, n: number): string {
  const t = s.replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// The same line arriving over two connections (the same network added twice,
// or direct + via a bouncer) raises one banner, not two.
const DUPLICATE_WINDOW_MS = 10_000;

// Whether the active conversation is on screen right now (ChatLayout: not
// while MY's Friends page or a phone's channel list covers it). A message
// there gets no toast only while it shows.
let conversationShown: () => boolean = () => true;
export function setConversationShown(fn: (() => boolean) | null): void {
  conversationShown = fn ?? (() => true);
}

export class Notifier {
  // DOM view of the window; `native` replaces it when the shell reports one.
  private domFocused = true;
  private domVisible = true;
  private native: WindowAttention | null = null;
  private started = false;
  private onActivate?: (serverId: string, channel: string) => void;
  private recent = new Map<string, number>();

  // Begin tracking window focus + ensure permission. Idempotent.
  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    const doc = typeof document !== 'undefined' ? document : null;
    const docVisible = (): boolean => !doc || doc.visibilityState !== 'hidden';
    this.domFocused = doc ? doc.hasFocus() : true;
    this.domVisible = docVisible();
    window.addEventListener('focus', () => { this.domFocused = true; this.refreshNative(); });
    window.addEventListener('blur', () => { this.domFocused = false; this.refreshNative(); });
    doc?.addEventListener('visibilitychange', () => {
      this.domVisible = docVisible();
      if (!this.domVisible) this.domFocused = false;
      this.refreshNative();
    });
    const bridge = getWindowBridge();
    if (bridge?.attention && bridge.onAttentionChange) {
      bridge.onAttentionChange(() => this.refreshNative());
      this.refreshNative();
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { void Notification.requestPermission(); } catch { /* ignore */ }
    }
  }

  // Re-read the native window state (no-op without a native bridge). A
  // failing bridge (a shell without these calls) leaves the DOM view in use.
  private refreshNative(): void {
    const bridge = getWindowBridge();
    if (!bridge?.attention) return;
    bridge.attention().then(
      (a) => { this.native = { focused: !!a.focused, visible: !!a.visible }; },
      () => { /* keep the DOM view */ },
    );
  }

  setOnActivate(fn: (serverId: string, channel: string) => void): void {
    this.onActivate = fn;
  }

  // What the user can see right now. The page being hidden (minimised,
  // occluded, app hidden) wins over everything; otherwise the native window
  // state when we have it, else DOM focus.
  attention(): WindowAttention {
    const visible = this.domVisible && (this.native ? this.native.visible : true);
    const focused = visible && (this.native ? this.native.focused : this.domFocused);
    return { focused, visible };
  }

  // Test seams.
  setFocusedForTest(v: boolean): void { this.domFocused = v; this.native = null; }
  setAttentionForTest(a: WindowAttention): void { this.native = a; this.domVisible = true; }
  isFocused(): boolean { return this.attention().focused; }

  notify(ev: NotifyEvent): void {
    const settings = getNotificationSettings();
    const level = getChannelLevel(ev.serverId, ev.channel);
    const att = this.attention();
    // The same line over two connections (a bouncer and a direct link)
    // shows once, as a toast and as a banner each.
    const toast = shouldToast(ev.open && !conversationShown() ? { ...ev, open: false } : ev, settings, level) && !this.isDuplicate(ev, 'toast');
    const os = shouldNotify(ev, settings, att, level) && !this.isDuplicate(ev, 'os');
    if (toast) {
      getNotificationFeed().toast({
        kind: ev.kind,
        title: ev.from,
        where: ev.kind === 'dm' ? `direct message${ev.serverName ? ` · ${ev.serverName}` : ''}` : `${ev.channel}${ev.serverName ? ` · ${ev.serverName}` : ''}`,
        body: clean(ev.text, 180),
        nick: ev.from,
        serverId: ev.serverId,
        channel: ev.channel,
      });
      // The OS plays its own sound with a banner.
      if (settings.sound && !os) chime();
    }
    if (os) this.showSystem(ev, settings);
  }

  private showSystem(ev: NotifyEvent, settings: NotificationSettings): void {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;

    const where = ev.kind === 'dm' ? ev.from : `${ev.from} · ${ev.channel}`;
    const title = ev.serverName ? `${where} · ${ev.serverName}` : where;
    try {
      const n = new Notification(title, {
        body: clean(ev.text, 180),
        tag: `${ev.serverId}:${ev.channel}`, // collapse repeats per conversation
        silent: !settings.sound,
      });
      n.onclick = (): void => {
        this.onActivate?.(ev.serverId, ev.channel);
        n.close();
      };
    } catch { /* OS refused / no display */ }
  }

  /**
   * A system notification for something that isn't a message (a friend
   * request, a missed call): only while Boson isn't focused, as for
   * messages. Returns whether one was shown.
   */
  notifyOther(n: { title: string; body: string; tag: string; onClick?: () => void }): boolean {
    const settings = getNotificationSettings();
    if (!settings.enabled || this.attention().focused) return false;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
    try {
      const sys = new Notification(n.title, { body: clean(n.body, 180), tag: n.tag, silent: !settings.sound });
      sys.onclick = (): void => {
        void getWindowBridge()?.show?.();
        n.onClick?.();
        sys.close();
      };
      return true;
    } catch { return false; }
  }

  private isDuplicate(ev: NotifyEvent, what: 'toast' | 'os'): boolean {
    const now = Date.now();
    for (const [k, at] of this.recent) if (now - at > DUPLICATE_WINDOW_MS) this.recent.delete(k);
    const key = [what, ev.kind, ev.from.toLowerCase(), ev.channel.toLowerCase(), ev.text].join('\0');
    if (this.recent.has(key)) return true;
    this.recent.set(key, now);
    return false;
  }
}

let singleton: Notifier | null = null;
export function getNotifier(): Notifier {
  if (!singleton) singleton = new Notifier();
  return singleton;
}
