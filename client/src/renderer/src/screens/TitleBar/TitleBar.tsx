import { useEffect, useState } from 'preact/hooks';
import { BosonGlyph } from '@boson/shared';
import { getWindowBridge, isDarwin } from '../../shared/window-controls';
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
}

// Custom window title bar. The OS chrome is suppressed in main (`frame: false`
// on Windows/Linux, `titleBarStyle: 'hiddenInset'` on macOS) so we draw our
// own. On macOS the native traffic-light buttons remain visible, so we only
// render a draggable region + the app brand; on Windows/Linux we draw all
// three controls (minimize, maximize/restore, close) on the right.
//
// Drag region: the title bar element itself sets `-webkit-app-region: drag`
// via CSS so the user can drag the window from any non-button area. Each
// button overrides to `no-drag` so clicks register.

export function TitleBar({ onOpenSettings, userLabel, userMode }: TitleBarProps = {}) {
  const darwin = isDarwin();
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
    <div class={`title-bar ${darwin ? 'title-bar-darwin' : ''}`}>
      <div class="title-bar-drag">
        <BosonGlyph size={16} class="title-bar-mark" />
        <span class="title-bar-title">Boson</span>
      </div>
      {onOpenSettings && (
        <div class="title-bar-controls">
          <button
            type="button"
            class="title-bar-user"
            aria-label="User settings"
            title="User settings"
            onClick={onOpenSettings}
          >
            {userLabel ? (
              <>
                <span class="title-bar-user-name">{userLabel}</span>
                {userMode === 'guest' && (
                  <span class="title-bar-user-tag">guest</span>
                )}
              </>
            ) : (
              <span class="title-bar-user-name">Settings</span>
            )}
            <GearIcon />
          </button>
        </div>
      )}
      {!darwin && (
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
