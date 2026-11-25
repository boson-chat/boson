import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Button, Divider, SwitchRow } from '@boson/shared';
import { getUpdater, useUpdateState, type UpdateState } from '../../modules/updater/updater';
// Pulled at build time from client/package.json. semantic-release keeps
// every workspace package.json in lockstep with the latest tag via
// scripts/sync-version.cjs, so this matches what the GitHub release
// page advertises for the installer the user is running.
import pkg from '../../../../../package.json';
import { DetailRow, SectionFrame } from './SettingsFrame';

const APP_VERSION = pkg.version;

// The browser's name for the About row of the web build.
export function browserName(ua: string): string {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\/|Chromium\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'browser';
}

// The platform as people call it: the shell's GOOS-style name
// (platform/wails.ts: darwin, win32, linux, ios, android) or, with no shell,
// navigator.platform's (MacIntel, Win32, Linux x86_64, iPhone).
export function platformLabel(raw: string): string {
  const p = raw.toLowerCase();
  if (p === 'ios' || /^(iphone|ipad|ipod)/.test(p)) return 'iOS';
  if (p === 'android' || p.includes('android')) return 'Android';
  if (p === 'darwin' || p.startsWith('mac')) return 'macOS';
  if (p === 'win32' || p === 'windows' || p.startsWith('win')) return 'Windows';
  if (p.includes('linux')) return 'Linux';
  if (p.includes('freebsd')) return 'FreeBSD';
  if (p.includes('openbsd')) return 'OpenBSD';
  return raw || 'Unknown';
}

export function AboutSection() {
  // Platform string is set by the shell's bridges (platform/wails.ts,
  // at startup). In a browser preview / e2e harness `bosonPlatform` may not
  // exist — fall back to navigator's hint so we still show something
  // useful instead of "undefined".
  const w = window as unknown as { bosonPlatform?: string; bosonShell?: string };
  const web = w.bosonShell === 'web';
  const platform = w.bosonPlatform ?? (typeof navigator !== 'undefined' ? navigator.platform : '');
  // The web build says so: the browser is the platform.
  const platformName = web
    ? `Web (${browserName(typeof navigator === 'undefined' ? '' : navigator.userAgent)})`
    : platformLabel(platform);

  // In-app updates (modules/updater): the shell's state, live, next to the
  // version, with "Check for updates" / "Update" / "Restart to update".
  // Nothing when there's no updater (a browser, iOS).
  const updater = getUpdater();
  const updateState = useUpdateState(updater);
  const notes = 'notes' in updateState ? updateState.notes : undefined;
  const notesVersion = 'version' in updateState ? updateState.version : undefined;
  // Several releases behind: the notes cover each release since this one.
  const notesSince = 'notesSince' in updateState ? updateState.notesSince : undefined;
  // "Install updates automatically": not on Android, where the system
  // installer always asks.
  const offerAuto = !!updater?.setAutoInstall && platform !== 'android';
  const [autoInstall, setAutoInstall] = useState(false);
  useEffect(() => {
    if (!offerAuto || !updater?.getAutoInstall) return;
    let live = true;
    void updater.getAutoInstall().then((v) => { if (live) setAutoInstall(!!v); }).catch(() => {});
    return () => { live = false; };
  }, [updater, offerAuto]);

  return (
    <SectionFrame
      title="About"
      description="What you're running, and where to find the source."
    >
      <div class="user-settings-stack">
        <DetailRow label="App" value="Boson" />
        <Divider />
        <DetailRow
          label="Version"
          customValue={
            <span class="user-settings-version-row">
              <span class="user-settings-mono">v{APP_VERSION}</span>
              {updater && (
                <UpdateActions
                  state={updateState}
                  platform={platform}
                  onCheck={() => void updater.checkNow()}
                  onDownload={() => void (updater.download ?? updater.applyDownloadedUpdate)()}
                  onApply={() => void updater.applyDownloadedUpdate()}
                />
              )}
            </span>
          }
        />
        {updater && updateState.kind === 'available' && updateState.manual && updateState.message && (
          <p class="user-settings-update-notice" role="note">{updateState.message}</p>
        )}
        {updater && notes && notesVersion && (
          <>
            <Divider />
            <DetailRow
              label={notesSince ? `What's new since v${notesSince}` : `What's new in v${notesVersion}`}
              customValue={<div class="user-settings-update-notes">{notes}</div>}
            />
          </>
        )}
        {offerAuto && (
          <>
            <Divider />
            <SwitchRow
              title="Install updates automatically"
              description="Downloads new versions in the background and installs them when you quit Boson."
              checked={autoInstall}
              onChange={(v) => {
                setAutoInstall(v);
                void updater?.setAutoInstall?.(v).catch(() => setAutoInstall(!v));
              }}
            />
          </>
        )}
        <Divider />
        <DetailRow label="Platform" value={platformName} />
        <Divider />
        <DetailRow label="Source" customValue={<ExternalLink href="https://github.com/boson-chat/boson">github.com/boson-chat/boson</ExternalLink>} />
        <Divider />
        <DetailRow
          label="Release notes"
          customValue={
            <ExternalLink href={`https://github.com/boson-chat/boson/releases/tag/v${APP_VERSION}`}>
              v{APP_VERSION} on GitHub →
            </ExternalLink>
          }
        />
      </div>
      <p class="user-settings-about-tag">
        Built on IRC. RFC 1459 · RFC 2812 · IRCv3.
      </p>
    </SectionFrame>
  );
}

// The desktop app never navigates its window to https URLs (they open in
// the OS browser instead). The shell's window.open hands them to
// desktop/links.go — preventDefault here just stops the in-window nav
// attempt that would precede that handoff.
function ExternalLink({ href, children }: { href: string; children: ComponentChildren }) {
  return (
    <a
      class="user-settings-link"
      href={href}
      onClick={(e) => {
        e.preventDefault();
        const bridge = (window as unknown as { open?: (u: string) => void }).open;
        if (bridge) bridge(href);
      }}
    >
      {children}
    </a>
  );
}

// Last line of defence against a raw updater HTTP error dump
// reaching the UI. The shell's updater already suppresses
// transient errors (offline, rate-limited, etc.) — this
// catches the edge case where a *permanent* error gets through but
// still has an unsuitable phrasing for end users. Maps the most common
// failure modes to short, actionable copy; everything else is passed
// through unchanged.
function summariseUpdateError(raw: string): string {
  if (/\b404\b/.test(raw) && /latest[^\s'"]*\.yml/i.test(raw)) {
    return "Update info isn't published yet. Try again in a few minutes.";
  }
  if (/ENOTFOUND|EAI_AGAIN|net::ERR_NAME_NOT_RESOLVED/i.test(raw)) {
    return "Couldn't reach update server — check your connection.";
  }
  if (/ECONNRESET|ETIMEDOUT|net::ERR_(TIMED_OUT|CONNECTION)/i.test(raw)) {
    return 'Network timeout while checking for updates.';
  }
  return raw;
}

// Inline update affordance rendered next to the version number. Stays
// compact in the common case (just a "Check for updates" button) and
// expands into an Update / progress / Restart prompt as an update moves
// along. Nothing installs without a click here (or the opt-in automatic
// installs).
export function UpdateActions({
  state,
  platform,
  onCheck,
  onDownload,
  onApply,
}: {
  state: UpdateState;
  platform?: string;
  onCheck: () => void;
  onDownload?: () => void;
  onApply: () => void;
}) {
  switch (state.kind) {
    case 'idle':
    case 'up-to-date':
    case 'error':
      return (
        <span class="user-settings-update-actions">
          <Button variant="ghost" onClick={onCheck}>Check for updates</Button>
          {state.kind === 'up-to-date' && (
            <span class="user-settings-update-hint">Up to date.</span>
          )}
          {state.kind === 'error' && (
            <span class="user-settings-update-hint user-settings-update-error" role="alert">
              {summariseUpdateError(state.message)}
            </span>
          )}
        </span>
      );
    case 'checking':
      return <span class="user-settings-update-hint">Checking…</span>;
    case 'available':
      if (state.manual) {
        return (
          <span class="user-settings-update-actions">
            <Button variant="primary" onClick={onApply}>Download v{state.version}</Button>
          </span>
        );
      }
      return (
        <span class="user-settings-update-actions">
          <Button variant="primary" onClick={onDownload ?? onApply}>Update to v{state.version}</Button>
          <span class="user-settings-update-hint">v{state.version} is available.</span>
        </span>
      );
    case 'downloading':
      return (
        <span class="user-settings-update-hint" role="status">
          Downloading v{state.version} · {Math.floor(state.percent || 0)}%
        </span>
      );
    case 'ready':
      return (
        <span class="user-settings-update-actions">
          <Button variant="primary" onClick={onApply}>
            {platform === 'android' ? `Install v${state.version}` : 'Restart to update'}
          </Button>
          <span class="user-settings-update-hint">v{state.version} is ready.</span>
        </span>
      );
  }
}
