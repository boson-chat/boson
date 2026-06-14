// Desktop notifications. The chat service calls notify() for every notifiable
// live message (mention / DM / plain) with full context; we decide whether to
// raise an OS notification based on the user's settings and whether the app
// window is focused (no banners while you're actively looking — the in-app
// unread/mention badges cover that). Clicking a banner focuses the window and
// switches to the originating server + channel.
import {
  getNotificationSettings,
  type NotificationSettings,
} from './notifications.store';

export type NotifyKind = 'mention' | 'dm' | 'message';

export interface NotifyEvent {
  serverId: string;
  serverName?: string;
  channel: string; // '#chan' for a channel mention; the sender's nick for a DM
  from: string;
  text: string;
  kind: NotifyKind;
}

// Pure decision: should this event raise an OS notification right now?
export function shouldNotify(ev: NotifyEvent, s: NotificationSettings, windowFocused: boolean): boolean {
  if (!s.enabled) return false;
  if (windowFocused) return false; // you're looking — the badge is enough
  if (ev.kind === 'dm') return s.directMessages;
  if (ev.kind === 'mention') return s.mentions;
  return s.allMessages;
}

// Strip IRC formatting / control codes (bold, color, etc.) and collapse runs of
// whitespace, then clamp to a banner-friendly length.
function clean(s: string, n: number): string {
  const t = s.replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export class Notifier {
  private focused = true;
  private started = false;
  private onActivate?: (serverId: string, channel: string) => void;

  // Begin tracking window focus + ensure permission. Idempotent.
  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    this.focused = typeof document !== 'undefined' ? document.hasFocus() : true;
    window.addEventListener('focus', () => { this.focused = true; });
    window.addEventListener('blur', () => { this.focused = false; });
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { void Notification.requestPermission(); } catch { /* ignore */ }
    }
  }

  setOnActivate(fn: (serverId: string, channel: string) => void): void {
    this.onActivate = fn;
  }

  // Test seam.
  setFocusedForTest(v: boolean): void { this.focused = v; }
  isFocused(): boolean { return this.focused; }

  notify(ev: NotifyEvent): void {
    const settings = getNotificationSettings();
    if (!shouldNotify(ev, settings, this.focused)) return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;

    const title = ev.kind === 'dm' ? ev.from : `${ev.from} · ${ev.channel}`;
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
}

let singleton: Notifier | null = null;
export function getNotifier(): Notifier {
  if (!singleton) singleton = new Notifier();
  return singleton;
}
