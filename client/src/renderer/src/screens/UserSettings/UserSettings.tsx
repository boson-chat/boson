import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Badge, Button, Card, Divider, Field, Input, Modal, Toggle, useTransientFlag } from '@boson/shared';
import { getBouncerStore, type BouncerProfile } from '../../modules/chat/bouncer.store';
import { Avatar } from '../../shared/Avatar/Avatar';
import { publishOwnAvatar } from '../../modules/chat/avatar-cache';
import {
  clearGuestSession,
  emitGuestChange,
  loadGuestSession,
  saveGuestSession,
} from '../../modules/guest/guest';
import { sanitizeIrcNick } from '../../modules/identity/nick';
import type { DirectoryService } from '../../modules/directory';
import type { IdentityService } from '../../modules/identity';
import type { AuthService } from '../../modules/auth';
import { RecoveryCodeReveal } from '../../components/RecoveryCodeReveal';
import { HttpError } from '../../shared/http/http.client';
// Pulled at build time from client/package.json. semantic-release keeps
// every workspace package.json in lockstep with the latest tag via
// scripts/sync-version.cjs, so this matches what the GitHub release
// page advertises for the installer the user is running.
import pkg from '../../../../../package.json';
import './UserSettings.css';

const APP_VERSION = pkg.version;

// Global user-level settings — appearance, identity, account. Opened from
// the gear icon in the title bar. Modal so it floats over whatever screen
// the user is currently on (chat, directory, server settings, login).
//
// Mode-aware: in guest mode the Identity section is editable + the Account
// section offers "Switch to an account"; in authenticated mode Identity
// shows the read-only handle + Account offers Sign out.
//
// Sections are surfaced via a left menu (matching the Server settings page
// pattern) with a scrolling body to the right.

type SectionId = 'identity' | 'appearance' | 'account' | 'bouncer' | 'about';

const MENU: ReadonlyArray<{ id: SectionId; label: string; description: string }> = [
  { id: 'identity',   label: 'Identity',   description: 'Display nick + handle' },
  { id: 'appearance', label: 'Appearance', description: 'Theme + density' },
  { id: 'account',    label: 'Account',    description: 'Sign in / out' },
  { id: 'bouncer',    label: 'Bouncer',    description: 'ZNC / BNC relay (advanced)' },
  { id: 'about',      label: 'About',      description: 'Version + project info' },
];

interface UserSettingsProps {
  open: boolean;
  onClose: () => void;
  // Authenticated handle when signed in via Supabase. Null in guest mode.
  // Cached on session.user_metadata.handle — the Identity section
  // re-syncs from the authoritative backend (/me) when opened.
  authedHandle: string | null;
  // Authenticated email (for the Account section). Null in guest mode.
  authedEmail: string | null;
  onSignOut: () => void;
  // Required for the Identity section's authoritative read + rename.
  // The renderer-only test harness wires these via buildApp().
  directory: DirectoryService;
  // Used by the Account section's recovery-code enroll/regenerate flow.
  identity: IdentityService;
  auth: AuthService;
}

export function UserSettings({ open, onClose, authedHandle, authedEmail, onSignOut, directory, identity, auth }: UserSettingsProps) {
  const [section, setSection] = useState<SectionId>('identity');
  const guest = loadGuestSession();
  const mode: 'guest' | 'account' = guest ? 'guest' : 'account';

  return (
    <Modal open={open} onClose={onClose} title="User settings">
      <div class="user-settings">
        <nav class="user-settings-menu" aria-label="Settings sections">
          {MENU.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={section === m.id}
              class={`user-settings-menu-item ${section === m.id ? 'user-settings-menu-item-active' : ''}`}
              onClick={() => setSection(m.id)}
            >
              <span class="user-settings-menu-label">{m.label}</span>
              <span class="user-settings-menu-desc">{m.description}</span>
            </button>
          ))}
        </nav>
        <div class="user-settings-body" role="tabpanel">
          {section === 'identity' && (
            <IdentitySection
              mode={mode}
              authedHandle={authedHandle}
              guestNick={guest?.nick ?? ''}
              directory={directory}
              auth={auth}
              open={open}
            />
          )}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'account' && (
            <AccountSection
              mode={mode}
              authedEmail={authedEmail}
              onSignOut={onSignOut}
              onClose={onClose}
              directory={directory}
              identity={identity}
              open={open}
            />
          )}
          {section === 'bouncer' && <BouncerSection mode={mode} open={open} />}
          {section === 'about' && <AboutSection />}
        </div>
      </div>
    </Modal>
  );
}

function IdentitySection({ mode, authedHandle, guestNick, directory, auth, open }: {
  mode: 'guest' | 'account';
  authedHandle: string | null;
  guestNick: string;
  directory: DirectoryService;
  auth: AuthService;
  open: boolean;
}) {
  return (
    <SectionFrame
      title="Identity"
      description={mode === 'guest'
        ? "Your local nickname. Changes here apply on the next connect."
        : "Your registered Boson handle, used as your IRC nickname after sanitisation."}
    >
      <Card>
        <div class="user-settings-card-body">
          {mode === 'account' ? (
            <>
              <AvatarSettings
                handle={authedHandle ?? ''}
                directory={directory}
                auth={auth}
                open={open}
              />
              <Divider />
              <AccountHandleForm
                authedHandle={authedHandle}
                directory={directory}
                auth={auth}
                open={open}
              />
            </>
          ) : (
            <GuestNickForm guestNick={guestNick} />
          )}
          <Divider />
          <DetailRow label="Mode" customValue={
            mode === 'guest'
              ? <Badge tone="info">Guest</Badge>
              : <Badge tone="verified">Account</Badge>
          } />
        </div>
      </Card>
    </SectionFrame>
  );
}

function GuestNickForm({ guestNick }: { guestNick: string }) {
  const [draft, setDraft] = useState(guestNick);
  const [saved, triggerSaved] = useTransientFlag();

  const submit = (e: Event): void => {
    e.preventDefault();
    const nick = sanitizeIrcNick(draft.trim());
    if (!nick) return;
    saveGuestSession({ nick });
    emitGuestChange();
    triggerSaved();
  };

  return (
    <form onSubmit={submit} class="user-settings-form">
      <Field
        label="Nick"
        hint="Sanitised on connect — IRC nicks can't contain @, ., or spaces."
      >
        <Input
          value={draft}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          required
          autoComplete="off"
          spellcheck={false}
        />
      </Field>
      <div class="user-settings-form-actions">
        {saved && <span class="user-settings-saved">Saved</span>}
        <Button type="submit" variant="primary" disabled={!draft.trim()}>Save</Button>
      </div>
    </form>
  );
}

// Editable global handle for signed-in users. Fetches the authoritative
// value from /me on mount (and whenever the modal re-opens) so a stale
// Supabase user_metadata cache can't pin the field to the wrong value.
// On save: PATCH /me first, then mirror the new handle into Supabase
// user_metadata so the TitleBar and the rest of the app pick it up
// without a reload.
// Profile-image control. Uploads to the backend (which resizes + stores in
// R2) and mirrors the resulting avatar_url into Supabase user_metadata so
// the TitleBar updates immediately. Falls back to the nick-colored initial.
function AvatarSettings({ handle, directory, auth, open }: {
  handle: string;
  directory: DirectoryService;
  auth: AuthService;
  open: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void directory.getMe()
      .then((me) => { if (!cancelled) setUrl(me?.avatar_url ?? null); })
      .catch(() => { /* keep fallback */ });
    return () => { cancelled = true; };
  }, [open, directory]);

  const onFile = async (e: Event): Promise<void> => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { setError('Please choose an image file.'); return; }
    if (file.size > 5 * 1024 * 1024) { setError('Image must be under 5 MB.'); return; }
    setBusy(true);
    setError(null);
    try {
      const updated = await directory.uploadAvatar(file);
      setUrl(updated.avatar_url ?? null);
      try { await auth.updateMetadata({ avatar_url: updated.avatar_url ?? null }); } catch { /* non-fatal */ }
      // Refresh it live in chat / member list (no reconnect).
      publishOwnAvatar(updated.avatar_url ?? null);
    } catch (err) {
      if (err instanceof HttpError && err.status === 503) setError('Profile images aren’t available right now.');
      else if (err instanceof HttpError && err.status === 413) setError('Image is too large (max 5 MB).');
      else if (err instanceof HttpError && err.status === 400) setError('That file isn’t a supported image.');
      else setError('Upload failed — try again.');
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const updated = await directory.deleteAvatar();
      setUrl(updated.avatar_url ?? null);
      try { await auth.updateMetadata({ avatar_url: null }); } catch { /* non-fatal */ }
      publishOwnAvatar(null);
    } catch {
      setError('Could not remove — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Field label="Profile image" hint="Shown to other Boson users wherever your nick appears.">
      <div class="user-settings-avatar">
        <Avatar nick={handle || '?'} url={url} size={64} />
        <div class="user-settings-avatar-actions">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style="display:none"
            onChange={(e) => { void onFile(e); }}
          />
          <Button type="button" variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? 'Working…' : (url ? 'Change' : 'Upload')}
          </Button>
          {url && (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => { void onRemove(); }}>
              Remove
            </Button>
          )}
        </div>
      </div>
      {error && <div class="user-settings-error">{error}</div>}
    </Field>
  );
}

function AccountHandleForm({ authedHandle, directory, auth, open }: {
  authedHandle: string | null;
  directory: DirectoryService;
  auth: AuthService;
  open: boolean;
}) {
  const [draft, setDraft] = useState(authedHandle ?? '');
  const [currentHandle, setCurrentHandle] = useState<string | null>(authedHandle);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, triggerSaved] = useTransientFlag();

  // Pull the authoritative handle from the backend each time the modal
  // opens. Guarded by `open` so closed-modal mounts (e.g. the
  // <UserSettings> instance App always renders) don't fire the request
  // until the user actually navigates here.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void directory.getMe()
      .then((me) => {
        if (cancelled) return;
        if (me) {
          setCurrentHandle(me.handle);
          setDraft(me.handle);
        }
      })
      .catch(() => { /* fall back to authedHandle silently */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, directory]);

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || trimmed === currentHandle) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await directory.updateMe({ handle: trimmed });
      setCurrentHandle(updated.handle);
      setDraft(updated.handle);
      // Mirror the new handle into Supabase user_metadata so the
      // TitleBar + any other consumer that reads from the session
      // sees the rename immediately. Failure here is non-fatal — the
      // backend already wrote the canonical value.
      try { await auth.updateMetadata({ handle: updated.handle }); } catch { /* non-fatal */ }
      triggerSaved();
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 409) setError('That handle is taken — pick another.');
        else if (err.status === 400) setError('Handle must be at least 3 characters.');
        else if (err.status === 404) setError('No account row yet. Sign in again to create one.');
        else setError('Could not save — try again.');
      } else {
        setError('Could not save — try again.');
      }
    } finally {
      setSaving(false);
    }
  };

  const trimmed = draft.trim();
  const disabled = saving || loading || !trimmed || trimmed === currentHandle;

  return (
    <form onSubmit={submit} class="user-settings-form">
      <Field
        label="Handle"
        hint="Your global Boson handle — what other users find you by."
      >
        <Input
          value={draft}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          required
          autoComplete="off"
          spellcheck={false}
          disabled={loading || saving}
        />
      </Field>
      {error && <div class="user-settings-error">{error}</div>}
      <div class="user-settings-form-actions">
        {saved && <span class="user-settings-saved">Saved</span>}
        <Button type="submit" variant="primary" disabled={disabled}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

function AppearanceSection() {
  return (
    <SectionFrame
      title="Appearance"
      description="Theme and density. Currently locked to the terminal-modern dark scheme; light + density toggles planned."
    >
      <Card>
        <div class="user-settings-card-body">
          <DetailRow label="Theme" customValue={<Badge tone="info">Dark (terminal-modern)</Badge>} />
          <Divider />
          <DetailRow label="Density" value="Comfortable" />
        </div>
      </Card>
    </SectionFrame>
  );
}

// Global bouncer (ZNC/BNC) profile. One per user; E2E-encrypted + synced via
// BouncerSyncService when signed in. The store persists locally regardless, so
// editing works in guest mode too (it just won't sync until signed in).
const EMPTY_BOUNCER: BouncerProfile = {
  enabled: false, host: '', port: 6697, tls: true,
  tlsInsecure: false, username: '', password: '',
};

function BouncerSection({ mode, open }: {
  mode: 'guest' | 'account';
  open: boolean;
}) {
  const [draft, setDraft] = useState<BouncerProfile>(EMPTY_BOUNCER);
  const [saved, triggerSaved] = useTransientFlag();

  // Load the stored profile when the section mounts / the modal re-opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const store = getBouncerStore();
    void store.whenHydrated().then(() => {
      if (cancelled) return;
      // Only load when something is actually stored — otherwise we'd clobber
      // an in-progress edit (the async resolve can land after the user has
      // started toggling/typing on a fresh, empty profile).
      const stored = store.get();
      if (stored) setDraft(stored);
    });
    return () => { cancelled = true; };
  }, [open]);

  const set = <K extends keyof BouncerProfile>(k: K, v: BouncerProfile[K]): void =>
    setDraft((d) => ({ ...d, [k]: v }));

  const submit = (e: Event): void => {
    e.preventDefault();
    getBouncerStore().set({ ...draft, host: draft.host.trim(), username: draft.username.trim() });
    triggerSaved();
  };

  const clear = (): void => {
    getBouncerStore().clear();
    setDraft(EMPTY_BOUNCER);
    triggerSaved();
  };

  return (
    <SectionFrame
      title="Bouncer (ZNC / BNC)"
      description="Route servers through an always-on IRC bouncer. Configure it once here, then enable it per-server in that server's settings. Advanced — most users don't need this."
    >
      <Card>
        <form onSubmit={submit} class="user-settings-card-body user-settings-form">
          <Toggle
            checked={draft.enabled}
            onChange={(v) => set('enabled', v)}
            label="Use a bouncer"
          />
          <Field label="Host" hint="Your ZNC/BNC hostname, e.g. znc.example.com.">
            <Input value={draft.host} onInput={(e) => set('host', (e.target as HTMLInputElement).value)}
              placeholder="znc.example.com" autoComplete="off" spellcheck={false} />
          </Field>
          <Field label="Port">
            <Input type="number" value={String(draft.port)}
              onInput={(e) => set('port', Number((e.target as HTMLInputElement).value) || 0)} />
          </Field>
          <Toggle checked={draft.tls} onChange={(v) => set('tls', v)} label="Use TLS" />
          <Toggle checked={draft.tlsInsecure} onChange={(v) => set('tlsInsecure', v)}
            label="Allow self-signed certificate" />
          {draft.tlsInsecure && (
            <p class="user-settings-warning">
              ⚠ Skips TLS certificate verification — only enable this for a bouncer with a
              self-signed cert that you trust. It weakens protection against interception.
            </p>
          )}
          <Field label="Username" hint="Your ZNC username. The per-server ZNC network name is appended automatically.">
            <Input value={draft.username} onInput={(e) => set('username', (e.target as HTMLInputElement).value)}
              placeholder="me" autoComplete="off" spellcheck={false} />
          </Field>
          <Field label="Password" hint="Your ZNC password. Stored encrypted; never sent to Boson's servers in the clear.">
            <Input type="password" value={draft.password}
              onInput={(e) => set('password', (e.target as HTMLInputElement).value)} autoComplete="off" />
          </Field>
          {mode === 'guest' && (
            <p class="user-settings-hint">
              Sign in to sync this bouncer across your devices. It's saved locally on this device for now.
            </p>
          )}
          <div class="user-settings-form-actions">
            {saved && <span class="user-settings-saved">Saved</span>}
            <Button type="button" variant="ghost" onClick={clear}>Clear</Button>
            <Button type="submit" variant="primary"
              disabled={draft.enabled && (!draft.host.trim() || !draft.username.trim())}>
              Save
            </Button>
          </div>
        </form>
      </Card>
    </SectionFrame>
  );
}

function AccountSection({ mode, authedEmail, onSignOut, onClose, directory, identity, open }: {
  mode: 'guest' | 'account';
  authedEmail: string | null;
  onSignOut: () => void;
  onClose: () => void;
  directory: DirectoryService;
  identity: IdentityService;
  open: boolean;
}) {
  if (mode === 'guest') {
    return (
      <SectionFrame
        title="Account"
        description="You're using Boson without an account. Switching to an account lets you register servers + sync across devices."
      >
        <div class="user-settings-actions">
          <Button
            variant="primary"
            onClick={() => {
              clearGuestSession();
              emitGuestChange();
              onClose();
            }}
          >
            Switch to an account
          </Button>
        </div>
      </SectionFrame>
    );
  }
  return (
    <SectionFrame
      title="Account"
      description="Signed in via Supabase. Sign out clears local state on this device and returns you to the login screen."
    >
      <Card>
        <div class="user-settings-card-body">
          <DetailRow label="Email" value={authedEmail ?? '—'} />
          <Divider />
          <RecoveryCodeSettings directory={directory} identity={identity} open={open} />
        </div>
      </Card>
      <div class="user-settings-actions">
        <Button variant="ghost" onClick={() => { onSignOut(); onClose(); }}>Sign out</Button>
      </div>
    </SectionFrame>
  );
}

// Recovery-code enroll / regenerate for signed-in users. Reads /me on open to
// learn whether a recovery wrap already exists (→ "Regenerate" vs "Set up").
// Enrolling wraps the in-memory user_secret under a fresh code and persists
// the wrap via PUT /me/secret-wraps; the one-time code is then shown once.
function RecoveryCodeSettings({ directory, identity, open }: {
  directory: DirectoryService;
  identity: IdentityService;
  open: boolean;
}) {
  const [hasRecovery, setHasRecovery] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealCode, setRevealCode] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void directory.getMe()
      .then((me) => { if (!cancelled) setHasRecovery(Boolean(me?.encrypted_user_secret_recovery)); })
      .catch(() => { if (!cancelled) setHasRecovery(null); });
    return () => { cancelled = true; };
  }, [open, directory]);

  const enroll = async (): Promise<void> => {
    setError(null);
    if (!identity.isUnlocked()) {
      setError('Your identity is locked. Sign in again, then set up a recovery code.');
      return;
    }
    setBusy(true);
    try {
      const { recoveryBlob, recoveryCode } = await identity.enrollRecoveryCode();
      await directory.updateSecretWraps({ recoveryBlob });
      setHasRecovery(true);
      setRevealCode(recoveryCode);
    } catch {
      setError('Could not set up a recovery code — try again.');
    } finally {
      setBusy(false);
    }
  };

  if (revealCode) {
    return (
      <RecoveryCodeReveal
        code={revealCode}
        intro="This replaces any previous recovery code. It's the only way back into
          your synced passwords if you forget your login password — save it now."
        continueLabel="Done"
        onContinue={() => setRevealCode(null)}
      />
    );
  }

  return (
    <div class="user-settings-recovery">
      <DetailRow
        label="Recovery code"
        customValue={
          hasRecovery === null
            ? <span class="user-settings-empty">—</span>
            : hasRecovery
              ? <Badge tone="verified">Enabled</Badge>
              : <Badge tone="warn">Not set up</Badge>
        }
      />
      {error && <div class="user-settings-error">{error}</div>}
      <div class="user-settings-form-actions">
        <Button type="button" variant={hasRecovery ? 'ghost' : 'primary'} disabled={busy} onClick={() => { void enroll(); }}>
          {busy ? 'Working…' : hasRecovery ? 'Regenerate recovery code' : 'Set up recovery code'}
        </Button>
      </div>
    </div>
  );
}

// Renderer-side shape of the auto-update state pushed by main. Kept
// inline here rather than imported from the preload module so the
// About panel stays self-contained (the preload package isn't always
// resolvable from a test renderer context).
type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; checkedAt: number }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number; bytesPerSecond: number }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string };

interface UpdaterBridge {
  getState(): Promise<UpdateState>;
  checkNow(): Promise<void>;
  applyDownloadedUpdate(): Promise<void>;
  onState(fn: (s: UpdateState) => void): () => void;
}

function AboutSection() {
  // Platform string is exposed by the preload bridge (set on Electron
  // launch). In a browser preview / e2e harness `bosonPlatform` may not
  // exist — fall back to navigator's hint so we still show something
  // useful instead of "undefined".
  const platform =
    (window as unknown as { bosonPlatform?: string }).bosonPlatform
    ?? (typeof navigator !== 'undefined' ? navigator.platform : 'unknown');

  // Auto-update integration. Pull the initial state from main on
  // mount, subscribe to live pushes, and offer a manual "Check now"
  // button next to the version row. The whole block degrades to "no
  // updater available" when the bridge isn't there (dev / e2e).
  const updater = (window as unknown as { bosonUpdater?: UpdaterBridge }).bosonUpdater;
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: 'idle' });
  useEffect(() => {
    if (!updater) return;
    let unsubscribed = false;
    void updater.getState().then((s) => { if (!unsubscribed) setUpdateState(s); });
    const off = updater.onState(setUpdateState);
    return () => { unsubscribed = true; off(); };
  }, [updater]);

  return (
    <SectionFrame
      title="About"
      description="What you're running, and where to find the source."
    >
      <Card>
        <div class="user-settings-card-body">
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
                    onCheck={() => void updater.checkNow()}
                    onApply={() => void updater.applyDownloadedUpdate()}
                  />
                )}
              </span>
            }
          />
          <Divider />
          <DetailRow label="Platform" value={platform} />
          <Divider />
          <DetailRow
            label="Source"
            customValue={
              <a
                class="user-settings-link"
                href="https://github.com/boson-chat/boson"
                onClick={(e) => {
                  // Electron renderers in production refuse navigation
                  // to https URLs (we want them to open in the OS
                  // browser instead). The main process picks these up
                  // via setWindowOpenHandler and shell.openExternal —
                  // preventDefault here just stops the in-window nav
                  // attempt that would precede that handoff.
                  e.preventDefault();
                  const bridge = (window as unknown as { open?: (u: string) => void }).open;
                  if (bridge) bridge('https://github.com/boson-chat/boson');
                }}
              >
                github.com/boson-chat/boson
              </a>
            }
          />
          <Divider />
          <DetailRow
            label="Release notes"
            customValue={
              <a
                class="user-settings-link"
                href={`https://github.com/boson-chat/boson/releases/tag/v${APP_VERSION}`}
                onClick={(e) => {
                  e.preventDefault();
                  const bridge = (window as unknown as { open?: (u: string) => void }).open;
                  if (bridge) bridge(`https://github.com/boson-chat/boson/releases/tag/v${APP_VERSION}`);
                }}
              >
                v{APP_VERSION} on GitHub →
              </a>
            }
          />
        </div>
      </Card>
      <p class="user-settings-about-tag">
        Built on IRC. RFC 1459 · RFC 2812 · IRCv3.
      </p>
    </SectionFrame>
  );
}

// Last line of defence against a raw electron-updater HttpError dump
// reaching the UI. The main process already classifies + suppresses
// transient errors (release-asset race window, offline, etc.) — this
// catches the edge case where a *permanent* error gets through but
// still has an unsuitable phrasing for end users. Maps the most common
// failure modes to short, actionable copy; everything else is passed
// through unchanged (but capped + first-line-only on the way in via
// classifyUpdaterError in the main process).
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
// expands into a progress / restart prompt when the lifecycle is
// actually doing something.
function UpdateActions({
  state,
  onCheck,
  onApply,
}: {
  state: UpdateState;
  onCheck: () => void;
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
            <span class="user-settings-update-hint user-settings-update-error">
              {summariseUpdateError(state.message)}
            </span>
          )}
        </span>
      );
    case 'checking':
      return <span class="user-settings-update-hint">Checking…</span>;
    case 'available':
      return (
        <span class="user-settings-update-hint">
          v{state.version} available — downloading.
        </span>
      );
    case 'downloading':
      return (
        <span class="user-settings-update-hint">
          Downloading v{state.version} · {state.percent}%
        </span>
      );
    case 'ready':
      return (
        <span class="user-settings-update-actions">
          <Button variant="primary" onClick={onApply}>
            Restart to apply v{state.version}
          </Button>
        </span>
      );
  }
}

interface SectionFrameProps { title: string; description?: string; children: ComponentChildren }
function SectionFrame({ title, description, children }: SectionFrameProps) {
  return (
    <section class="user-settings-section">
      <div class="user-settings-section-head">
        <h2 class="user-settings-section-title">{title}</h2>
        {description && <p class="user-settings-section-desc">{description}</p>}
      </div>
      <div class="user-settings-section-body">{children}</div>
    </section>
  );
}

interface DetailRowProps { label: string; value?: string | null; customValue?: ComponentChildren }
function DetailRow({ label, value, customValue }: DetailRowProps) {
  return (
    <div class="user-settings-row">
      <dt class="user-settings-label">{label}</dt>
      <dd class="user-settings-value">
        {customValue ?? (value ? <span>{value}</span> : <span class="user-settings-empty">—</span>)}
      </dd>
    </div>
  );
}
