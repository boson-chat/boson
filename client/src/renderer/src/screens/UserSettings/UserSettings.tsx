import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { getUpdater, useUpdateState, type UpdateState } from '../../modules/updater/updater';
import { Badge, Button, Card, Divider, Field, Input, ListRow, Modal, SwitchRow, Toggle, useTransientFlag } from '@boson/shared';
import { getBouncerStore, type BouncerProfile } from '../../modules/chat/bouncer.store';
import { getEmbedSettings, setEmbedSettings, type EmbedSettings } from '../../modules/ui/embeds.store';
import { IncomingCallsSetting } from '../Notifications/IncomingCalls';
import { getPrivacySettings, setPrivacySettings, type PrivacySettings } from '../../modules/ui/privacy.store';
import { clearAllSeen } from '../../modules/seen';
import {
  getNotificationSettings, setNotificationSettings, type NotificationSettings,
} from '../../modules/ui/notifications.store';
import { Avatar } from '../../shared/Avatar/Avatar';
import { FileDropArea, FileDropHint } from '../../shared/FileDrop/FileDropArea';
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
import { describeAuthError, type AuthService, type LinkedIdentities } from '../../modules/auth';
import { RecoveryCodeReveal } from '../../components/RecoveryCodeReveal';
import { AppearancePanel } from './AppearancePanel';
import { VoiceSettingsSection } from './VoiceSettings';
import { getVoiceController } from '../../modules/voice';
import { HttpError } from '../../shared/http/http.client';
import { DirectoriesSection } from './DirectoriesSection';
import { NetworkAccountsSection } from './NetworkAccountsSection';
import { forgetDims, imagesBridge, type ImageCacheStats } from '../../shared/image-cache';
import { formatBytes } from '../../modules/files';
// Pulled at build time from client/package.json. semantic-release keeps
// every workspace package.json in lockstep with the latest tag via
// scripts/sync-version.cjs, so this matches what the GitHub release
// page advertises for the installer the user is running.
import pkg from '../../../../../package.json';
import { getFriendsController } from '../../modules/friends';
import { PrivacyCalls } from '../Friends/PrivacyCalls';
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

type SectionId = 'identity' | 'appearance' | 'content' | 'notifications' | 'voice' | 'privacy' | 'account' | 'networks' | 'directories' | 'bouncer' | 'about';

const MENU: ReadonlyArray<{ id: SectionId; label: string; description: string }> = [
  { id: 'identity',      label: 'Identity',      description: 'Display nick + handle' },
  { id: 'appearance',    label: 'Appearance',    description: 'Themes + colours' },
  { id: 'content',       label: 'Content',       description: 'Link previews / embeds, remembered hosts' },
  { id: 'notifications', label: 'Notifications', description: 'Desktop alerts' },
  { id: 'voice',         label: 'Voice',         description: 'Mic, speakers, push to talk' },
  { id: 'privacy',       label: 'Privacy & calls', description: 'Who can call you, friend requests' },
  { id: 'account',    label: 'Account',    description: 'Sign in / out' },
  { id: 'networks',   label: 'Network accounts', description: 'Self-hosted networks' },
  { id: 'directories', label: 'Directories', description: 'Where servers are listed' },
  { id: 'bouncer',    label: 'Bouncer',    description: 'ZNC / BNC relay (advanced)' },
  { id: 'about',      label: 'About',      description: 'Version + project info' },
];

interface UserSettingsProps {
  open: boolean;
  onClose: () => void;
  // Authenticated handle when signed in to an account. Null in guest mode.
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
  // Open at this section (e.g. 'voice' from the voice bar's gear).
  initialSection?: string | null;
}

export function UserSettings({ open, onClose, authedHandle, authedEmail, onSignOut, directory, identity, auth, initialSection }: UserSettingsProps) {
  const [section, setSection] = useState<SectionId>('identity');
  // Voice settings only where there's voice (the desktop app).
  const hasVoice = getVoiceController() !== null;
  // Privacy & calls with an account (friends and calls are on it).
  const hasFriends = getFriendsController()?.getSnapshot().available === true;
  const menu = MENU.filter((m) => (m.id !== 'voice' || hasVoice) && (m.id !== 'privacy' || hasFriends));
  useEffect(() => {
    if (open && initialSection && menu.some((m) => m.id === initialSection)) setSection(initialSection as SectionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialSection]);
  const guest = loadGuestSession();
  const mode: 'guest' | 'account' = guest ? 'guest' : 'account';

  return (
    <Modal open={open} onClose={onClose} title="User settings">
      <div class="user-settings">
        <nav class="user-settings-menu" aria-label="Settings sections">
          {menu.map((m) => (
            <ListRow
              key={m.id}
              variant="nav"
              title={m.label}
              subtitle={m.description}
              subtitleLines={2}
              selected={section === m.id}
              onClick={() => setSection(m.id)}
              mainProps={{ role: 'tab', 'aria-selected': section === m.id }}
            />
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
          {section === 'content' && <ContentSection />}
          {section === 'notifications' && <NotificationsSection />}
          {section === 'voice' && hasVoice && <VoiceSettingsSection open={open} />}
          {section === 'privacy' && (
            <SectionFrame title="Privacy & calls" description="Who can call you and send you friend requests. Calls ring while Boson is open.">
              <PrivacyCalls layout="desktop" />
            </SectionFrame>
          )}
          {section === 'account' && (
            <AccountSection
              mode={mode}
              authedEmail={authedEmail}
              onSignOut={onSignOut}
              onClose={onClose}
              directory={directory}
              identity={identity}
              auth={auth}
              open={open}
            />
          )}
          {section === 'networks' && <NetworkAccountsSection open={open} />}
          {section === 'directories' && <DirectoriesSection />}
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
// session user_metadata cache can't pin the field to the wrong value.
// On save: PATCH /me first, then mirror the new handle into the session's
// user_metadata cache so the TitleBar and the rest of the app pick it up
// without a reload.
// Profile-image control. Uploads to the backend (which resizes + stores in
// R2) and mirrors the resulting avatar_url into the session's user_metadata so
// the TitleBar updates immediately. Falls back to the nick-colored initial.
const NOT_AN_IMAGE = 'Please choose an image file.';

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

  // Chosen through the input or dropped onto the picker — same path.
  const onFile = async (file: File): Promise<void> => {
    if (!file.type.startsWith('image/')) { setError(NOT_AN_IMAGE); return; }
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
    <FileDropArea
      class="user-settings-avatar-drop"
      accept="image/*"
      disabled={busy}
      onFile={(file) => { void onFile(file); }}
      onReject={() => setError(NOT_AN_IMAGE)}
    >
      <Field label="Profile image" hint="Shown to other Boson users wherever your nick appears.">
        <div class="user-settings-avatar">
          <Avatar nick={handle || '?'} url={url} size={64} />
          <div class="user-settings-avatar-actions">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style="display:none"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = '';
                if (file) void onFile(file);
              }}
            />
            <Button type="button" variant="secondary" disabled={busy} aria-describedby="user-avatar-drop-hint" onClick={() => fileRef.current?.click()}>
              {busy ? 'Working…' : (url ? 'Change' : 'Upload')}
            </Button>
            {url && (
              <Button type="button" variant="ghost" disabled={busy} onClick={() => { void onRemove(); }}>
                Remove
              </Button>
            )}
            <FileDropHint id="user-avatar-drop-hint" />
          </div>
        </div>
        {error && <div class="user-settings-error">{error}</div>}
      </Field>
    </FileDropArea>
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
      // Mirror the new handle into the session's user_metadata so the
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
      description="Pick a theme, or customize one: every colour in the app comes from it. Changes apply instantly."
    >
      <AppearancePanel />
    </SectionFrame>
  );
}

// Link-embed preferences (local-only). Privacy-first: nothing loads remote
// content until clicked unless the user opts into auto-load.
function ContentSection() {
  const [s, setS] = useState<EmbedSettings>(() => getEmbedSettings());
  const update = (patch: Partial<EmbedSettings>): void => { setEmbedSettings(patch); setS(getEmbedSettings()); };
  return (
    <SectionFrame
      title="Content"
      description="Rich previews for links (images, videos, YouTube, Spotify, website cards). Previews load automatically — switch to click-to-load below if you'd rather nothing fetch remote content (or reveal your IP) until you click."
    >
      <Card>
        <div class="user-settings-card-body">
          <Toggle checked={s.enabled} label="Show link embeds" onChange={(v) => update({ enabled: v })} />
          <Divider />
          <Toggle
            checked={s.loadMode === 'auto'}
            disabled={!s.enabled}
            label="Auto-load previews (turn off to load on click — more private)"
            onChange={(v) => update({ loadMode: v ? 'auto' : 'click' })}
          />
          <Divider />
          <Toggle checked={s.images} disabled={!s.enabled} label="Images" onChange={(v) => update({ images: v })} />
          <Toggle checked={s.videos} disabled={!s.enabled} label="Videos" onChange={(v) => update({ videos: v })} />
          <Toggle checked={s.youtube} disabled={!s.enabled} label="YouTube" onChange={(v) => update({ youtube: v })} />
          <Toggle checked={s.spotify} disabled={!s.enabled} label="Spotify" onChange={(v) => update({ spotify: v })} />
          <Toggle checked={s.websites} disabled={!s.enabled} label="Website cards" onChange={(v) => update({ websites: v })} />
        </div>
      </Card>
      <ImageCacheCard />
      <RememberedHostsCard />
    </SectionFrame>
  );
}

// Who people were after they've left: user@host, account, real name, kept
// on this device only and never sent anywhere (modules/seen).
function RememberedHostsCard() {
  const [p, setP] = useState<PrivacySettings>(() => getPrivacySettings());
  const [cleared, flashCleared] = useTransientFlag();
  const update = (patch: Partial<PrivacySettings>): void => { setPrivacySettings(patch); setP(getPrivacySettings()); };
  return (
    <Card>
      <div class="user-settings-card-body">
        <Toggle
          checked={p.rememberHosts}
          label="Remember people's hosts after they leave"
          onChange={(v) => update({ rememberHosts: v })}
        />
        <Toggle
          checked={p.showHostsInActivity}
          disabled={!p.rememberHosts}
          label="Show hosts in join/part lines"
          onChange={(v) => update({ showHostsInActivity: v })}
        />
        <p class="user-settings-image-cache-text">
          Keeps each nick's last user@host, account and real name on this device, so their profile and /whois still
          show who they were once they've gone. Never sent anywhere.
        </p>
        <div class="user-settings-image-cache-actions">
          <Button variant="secondary" size="sm" onClick={() => { void clearAllSeen().then(flashCleared); }}>
            Clear remembered hosts
          </Button>
          {cleared && <span class="user-settings-image-cache-text" role="status">Cleared</span>}
        </div>
      </div>
    </Card>
  );
}

// Images seen before load from this device (desktop/imagecache.go). Only in
// the desktop app.
const IMAGE_CACHE_SIZES_MB = [250, 500, 1000, 2000];

function ImageCacheCard() {
  const bridge = imagesBridge();
  const [stats, setStats] = useState<ImageCacheStats | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge.stats().then((st) => { if (alive) setStats(st); }, () => {});
    return () => { alive = false; };
  }, [bridge]);
  if (!bridge) return null;
  const limitMB = stats ? Math.round(stats.limitBytes / 1048576) : 500;
  const sizes = IMAGE_CACHE_SIZES_MB.includes(limitMB) ? IMAGE_CACHE_SIZES_MB : [...IMAGE_CACHE_SIZES_MB, limitMB].sort((a, b) => a - b);
  return (
    <Card>
      <div class="user-settings-card-body user-settings-image-cache">
        <p class="user-settings-image-cache-text">
          Images you've seen are kept on this device, so they show at once next time.
          {stats && !stats.error && <> Using <strong>{formatBytes(stats.usedBytes)}</strong> of {formatBytes(stats.limitBytes)}.</>}
        </p>
        <div class="user-settings-image-cache-actions">
          <label class="user-settings-image-cache-label">
            Keep up to
            <select
              class="bds-input bds-input-sm"
              aria-label="Image cache size"
              value={String(limitMB)}
              onChange={(e) => { void bridge.setLimitMB(Number((e.target as HTMLSelectElement).value)).then(setStats); }}
            >
              {sizes.map((mb) => <option key={mb} value={String(mb)}>{mb >= 1000 ? `${mb / 1000} GB` : `${mb} MB`}</option>)}
            </select>
          </label>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => { forgetDims(); void bridge.clear().then(setStats); }}
          >
            Clear image cache
          </Button>
        </div>
      </div>
    </Card>
  );
}

function NotificationsSection() {
  const [s, setS] = useState<NotificationSettings>(() => getNotificationSettings());
  const update = (patch: Partial<NotificationSettings>): void => {
    setNotificationSettings(patch);
    setS(getNotificationSettings());
  };
  const off = !s.inApp && !s.enabled;
  return (
    <SectionFrame
      title="Notifications"
      description="Toasts in the corner (a banner from the top on phones) for things happening somewhere you're not looking, and system notifications while Boson is in the background. Everything also collects under the bell."
    >
      <Card>
        <div class="user-settings-card-body">
          <SwitchRow title="In-app toasts" description="A card in the corner when something happens elsewhere in Boson." checked={s.inApp} onChange={(v) => update({ inApp: v })} />
          <SwitchRow title="System notifications" description="OS banners when Boson is in the background or minimised." checked={s.enabled} onChange={(v) => update({ enabled: v })} />
          <Divider />
          <SwitchRow title="Mentions" description="Someone says your nick." checked={s.mentions} disabled={off} onChange={(v) => update({ mentions: v })} />
          <SwitchRow title="Direct messages" description="Any 1:1 message." checked={s.directMessages} disabled={off} onChange={(v) => update({ directMessages: v })} />
          <SwitchRow title="Friends" description="Requests and accepts." checked={s.friends} disabled={off} onChange={(v) => update({ friends: v })} />
          <SwitchRow title="Calls" description="Missed calls, and calls starting in voice channels you're in." checked={s.calls} disabled={off} onChange={(v) => update({ calls: v })} />
          <SwitchRow title="Every channel message" description="Noisy. Or pick channels: right-click one → Notifications → All messages." checked={s.allMessages} disabled={off} onChange={(v) => update({ allMessages: v })} />
          <Divider />
          <SwitchRow title="Sound" description="A short chime with each one." checked={s.sound} disabled={off} onChange={(v) => update({ sound: v })} />
        </div>
      </Card>
      <Card>
        <div class="user-settings-card-body">
          <IncomingCallsSetting />
        </div>
      </Card>
      <p class="user-settings-notify-note">Per channel: right-click a channel (long-press on a phone) → Notifications: All messages, Mentions only or Nothing.</p>
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
          <Toggle checked={draft.floodControl !== false} onChange={(v) => set('floodControl', v)}
            label="Flood control" />
          <p class="user-settings-hint">
            Paces what Boson sends so the network doesn't disconnect you for flooding. A bouncer
            paces lines to the network itself, so you can turn this off to send without delay.
            Reconnects servers that use the bouncer.
          </p>
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

function AccountSection({ mode, authedEmail, onSignOut, onClose, directory, identity, auth, open }: {
  mode: 'guest' | 'account';
  authedEmail: string | null;
  onSignOut: () => void;
  onClose: () => void;
  directory: DirectoryService;
  identity: IdentityService;
  auth: AuthService;
  open: boolean;
}) {
  if (mode === 'guest') {
    return (
      <SectionFrame
        title="Account"
        description="You're using Boson without a boson.chat account (accounts on other networks are under Network accounts). A boson.chat account lets you register servers, keep an identity key and sync across devices."
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
      description="Signed in to your Boson account. Sign out clears local state on this device and returns you to the login screen."
    >
      <Card>
        <div class="user-settings-card-body">
          <DetailRow label="Email" value={authedEmail ?? '—'} />
          <Divider />
          <RecoveryCodeSettings directory={directory} identity={identity} open={open} />
        </div>
      </Card>
      <LinkedSignIns auth={auth} open={open} />
      <div class="user-settings-actions">
        <Button variant="ghost" onClick={() => { onSignOut(); onClose(); }}>Sign out</Button>
      </div>
    </SectionFrame>
  );
}

// "Sign in with …" identities linked to the account, each with Unlink.
// Hidden while there are none (and when the auth service can't list them).
// Unlinking the last way in (no password, no other link) is refused (409
// last_login_method); that row's button is disabled up front.
function LinkedSignIns({ auth, open }: { auth: AuthService; open: boolean }) {
  const [data, setData] = useState<LinkedIdentities | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || typeof auth.identities !== 'function') return;
    let cancelled = false;
    void auth.identities()
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [open, auth]);

  if (!data || data.identities.length === 0) return null;
  const only = !data.has_password && data.identities.length === 1;

  const unlink = async (id: string): Promise<void> => {
    setBusy(id);
    setError(null);
    try {
      await auth.unlinkIdentity(id);
      setData(await auth.identities());
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <div class="user-settings-card-body user-settings-identities">
        <div class="user-settings-identities-head">
          <span class="user-settings-identities-title">Linked sign-ins</span>
          <span class="user-settings-identities-desc">
            {data.has_password ? 'You can also sign in with your password.' : 'This account has no password: these are the ways in.'}
          </span>
        </div>
        <ul class="user-settings-identities-list">
          {data.identities.map((i) => (
            <ListRow
              key={i.id}
              as="li"
              title={i.provider_display_name || i.provider_slug}
              subtitle={<>
                {i.email ?? i.subject}
                {i.last_login_at ? `, last used ${new Date(i.last_login_at).toLocaleDateString()}` : ''}
              </>}
              trailing={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null || only}
                  loading={busy === i.id}
                  title={only ? "It's the only way to sign in to this account" : undefined}
                  onClick={() => { void unlink(i.id); }}
                >
                  Unlink
                </Button>
              }
            />
          ))}
        </ul>
        {error && <div class="user-settings-error" role="alert">{error}</div>}
      </div>
    </Card>
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

// The browser's name for the About row of the web build.
export function browserName(ua: string): string {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\/|Chromium\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'browser';
}

function AboutSection() {
  // Platform string is set by the shell's bridges (platform/wails.ts,
  // at startup). In a browser preview / e2e harness `bosonPlatform` may not
  // exist — fall back to navigator's hint so we still show something
  // useful instead of "undefined".
  // The web build (platform/web) says so: the browser is the platform.
  const w = window as unknown as { bosonPlatform?: string; bosonShell?: string };
  const platform = w.bosonShell === 'web'
    ? `Web (${browserName(typeof navigator === 'undefined' ? '' : navigator.userAgent)})`
    : w.bosonPlatform ?? (typeof navigator !== 'undefined' ? navigator.platform : 'unknown');

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
              <div class="user-settings-update-auto">
                <Toggle
                  checked={autoInstall}
                  label="Install updates automatically"
                  onChange={(v) => {
                    setAutoInstall(v);
                    void updater?.setAutoInstall?.(v).catch(() => setAutoInstall(!v));
                  }}
                />
                <p class="user-settings-hint">Downloads new versions in the background and installs them when you quit Boson.</p>
              </div>
            </>
          )}
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
                  // The desktop app never navigates its window to
                  // https URLs (they open in the OS browser instead).
                  // The shell's window.open hands them to
                  // desktop/links.go — preventDefault here just stops
                  // the in-window nav attempt that would precede that
                  // handoff.
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
