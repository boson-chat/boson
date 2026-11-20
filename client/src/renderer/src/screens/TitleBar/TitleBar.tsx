import { useEffect, useState } from 'preact/hooks';
import { BosonGlyph } from '@boson/shared';
import { Avatar } from '../../shared/Avatar/Avatar';
import { getWindowBridge, isDarwin, isMobile } from '../../shared/window-controls';
import { useVoice } from '../../modules/voice';
import { useNarrow } from '../../shared/narrow';
import { openCall, useCallClock } from '../ChatLayout/call-shared';
import { Bell } from 'lucide-preact';
import './TitleBar.css';

interface TitleBarProps {
  // Optional global-settings opener. Mounted as a gear button between the
  // brand mark and the window controls. Rendered only when wired.
  onOpenSettings?: () => void;
  // Current user's display name (handle / guest nick). When provided it
  // renders before the gear as a clickable label that also opens settings.
  userLabel?: string | null;
  // 'guest' or 'account' — drives the dim "guest" tag next to the name.
  userMode?: 'guest' | 'account' | null;
  // Signed-in user's profile-image URL; shown as a small avatar before the
  // name. Falls back to the nick-colored initial when absent.
  avatarUrl?: string | null;
  // The notifications bell (mentions, DMs, memos, friends, calls) with
  // its unread count; `notificationsOpen` while its list shows.
  onOpenNotifications?: () => void;
  notificationsCount?: number;
  notificationsOpen?: boolean;
  // An update is downloaded and ready (its version): a small "Update" pill
  // before the inbox, which fires onOpenUpdate (Settings → About).
  updateReady?: string | null;
  onOpenUpdate?: () => void;
}

// Custom window title bar. The OS chrome is suppressed in main (`frame: false`
// on Windows/Linux, `titleBarStyle: 'hiddenInset'` on macOS) so we draw our
// own. On macOS the native traffic-light buttons remain visible, so we only
// render a draggable region + the app brand; on Windows/Linux we draw all
// three controls (minimize, maximize/restore, close) on the right. On iOS
// and Android there's no window to control: no controls at all.
//
// Drag region: the title bar element itself sets `-webkit-app-region: drag`
// via CSS so the user can drag the window from any non-button area. Each
// button overrides to `no-drag` so clicks register.

export function TitleBar({
  onOpenSettings, userLabel, userMode, avatarUrl, onOpenNotifications, notificationsCount = 0, notificationsOpen = false,
  updateReady, onOpenUpdate,
}: TitleBarProps = {}) {
  const darwin = isDarwin();
  const mobile = isMobile();
  // Phones (and narrow windows): the phone's top bar, the same bar as the
  // desktop's, taller, with your avatar in place of your name.
  const narrow = useNarrow();
  const phone = mobile || narrow;
  const bridge = getWindowBridge();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge.isMaximized().then((v) => {
      if (!cancelled) setMaximized(v);
    });
    const unsubscribe = bridge.onMaximizedChange(setMaximized);
    return () => { cancelled = true; unsubscribe(); };
  }, [bridge]);

  return (
    <div class={`title-bar ${darwin ? 'title-bar-darwin' : ''} ${mobile ? 'title-bar-mobile' : ''} ${phone ? 'title-bar-phone' : ''}`}>
      <div class="title-bar-drag">
        <BosonGlyph size={phone ? 20 : 16} class="title-bar-mark" />
        <span class="title-bar-title">Boson</span>
      </div>
      {(onOpenSettings || onOpenNotifications || (updateReady && onOpenUpdate)) && (
        <div class="title-bar-controls">
          <CallPill />
          {updateReady && onOpenUpdate && (
            <button
              type="button"
              class="title-bar-update"
              aria-label={`Boson v${updateReady} is ready — restart to update`}
              title={`Boson v${updateReady} is ready — restart to update`}
              onClick={onOpenUpdate}
            >
              <span class="title-bar-update-dot" aria-hidden="true" />
              <span class="title-bar-update-label">Update</span>
            </button>
          )}
          {onOpenNotifications && (
            <button
              type="button"
              class={`title-bar-inbox title-bar-bell${notificationsOpen ? ' title-bar-bell-on' : ''}`}
              aria-label={notificationsCount > 0 ? `Notifications, ${notificationsCount} unread` : 'Notifications'}
              aria-haspopup="dialog"
              aria-expanded={notificationsOpen}
              title="Notifications"
              onClick={onOpenNotifications}
            >
              <Bell size={phone ? 18 : 13} aria-hidden="true" />
              {notificationsCount > 0 && (
                <span class="title-bar-inbox-badge" aria-hidden="true">
                  {notificationsCount > 99 ? '99+' : notificationsCount}
                </span>
              )}
            </button>
          )}
          {onOpenSettings && (
            <button
              type="button"
              class="title-bar-user"
              aria-label="User settings"
              title="User settings"
              onClick={onOpenSettings}
            >
              {phone ? (
                userLabel ? <Avatar nick={userLabel} url={userMode === 'account' ? avatarUrl : null} size={28} class="title-bar-user-avatar" /> : <GearIcon />
              ) : userLabel ? (
                <>
                  {userMode === 'account' && (
                    <Avatar nick={userLabel} url={avatarUrl} size={18} class="title-bar-user-avatar" />
                  )}
                  <span class="title-bar-user-name">{userLabel}</span>
                  {userMode === 'guest' && (
                    <span class="title-bar-user-tag">guest</span>
                  )}
                </>
              ) : (
                <span class="title-bar-user-name">Settings</span>
              )}
              {!phone && <GearIcon />}
            </button>
          )}
        </div>
      )}
      {!darwin && !mobile && (
        <div class="title-bar-controls">
          <button
            type="button"
            class="title-bar-btn title-bar-btn-min"
            aria-label="Minimize"
            onClick={() => bridge?.minimize()}
          >
            <MinimizeIcon />
          </button>
          <button
            type="button"
            class="title-bar-btn title-bar-btn-max"
            aria-label={maximized ? 'Restore' : 'Maximize'}
            onClick={() => bridge?.toggleMaximize()}
          >
            {maximized ? <RestoreIcon /> : <MaximizeIcon />}
          </button>
          <button
            type="button"
            class="title-bar-btn title-bar-btn-close"
            aria-label="Close"
            onClick={() => bridge?.close()}
          >
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  );
}

// Glyphs are drawn as SVG rather than Unicode so they render consistently
// across platforms and stay crisp at any zoom level. 10×10 viewBox matches
// the visual weight of the surrounding mono text.

function MinimizeIcon() {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <line x1="1.5" y1="5" x2="8.5" y2="5" stroke="currentColor" stroke-width="1" stroke-linecap="square" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <rect x="2.5" y="1.5" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1" />
      <rect x="1.5" y="2.5" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1" />
    </svg>
  );
}

function GearIcon() {
  // Minimalist gear at 12×12 — 8 teeth, single stroke, no fill. Sized so it
  // visually matches the min/max/close glyphs in the same row.
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <circle cx="6" cy="6" r="1.4" fill="none" stroke="currentColor" stroke-width="1" />
      <path
        d="M6 1 L6 2.5 M6 9.5 L6 11 M1 6 L2.5 6 M9.5 6 L11 6 M2.5 2.5 L3.5 3.5 M8.5 8.5 L9.5 9.5 M2.5 9.5 L3.5 8.5 M8.5 3.5 L9.5 2.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1"
        stroke-linecap="square"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <line x1="1.5" y1="1.5" x2="8.5" y2="8.5" stroke="currentColor" stroke-width="1" stroke-linecap="square" />
      <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" stroke="currentColor" stroke-width="1" stroke-linecap="square" />
    </svg>
  );
}

// "In call · General · 12:04" while you're in a call (desktop): back to
// the call from anywhere.
function CallPill() {
  const { snap } = useVoice();
  const narrow = useNarrow();
  const clock = useCallClock(snap.callSince);
  const call = snap.call;
  if (narrow || call.status !== 'connected' || !call.host) return null;
  const where = call.roomName || call.room;
  return (
    <button type="button" class="title-bar-call" onClick={openCall} aria-label={`In call in ${where}${clock ? `, ${clock}` : ''}: open the call`}>
      <span class="title-bar-call-dot" aria-hidden="true" />
      In call · {where}{clock ? ` · ${clock}` : ''}
    </button>
  );
}
