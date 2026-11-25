import { useEffect, useRef, useState } from 'preact/hooks';
import { Badge, Button, Divider, Field, Input, useTransientFlag } from '@boson/shared';
import { Avatar } from '../../shared/Avatar/Avatar';
import { FileDropArea, FileDropHint } from '../../shared/FileDrop/FileDropArea';
import { publishOwnAvatar } from '../../modules/chat/avatar-cache';
import { emitGuestChange, saveGuestSession } from '../../modules/guest/guest';
import { sanitizeIrcNick } from '../../modules/identity/nick';
import type { DirectoryService } from '../../modules/directory';
import { validateHandle, type AuthService } from '../../modules/auth';
import { emitHandleChange } from '../../modules/ui/handle-change';
import { HttpError } from '../../shared/http/http.client';
import { describeHandleError } from '../../modules/directory/handle-error';
import { DetailRow, SectionFrame } from './SettingsFrame';

// Settings → Profile: what other people see. With an account, the profile
// image and the handle (which is the nick too); as a guest, the nick.
export function ProfileSection({ mode, authedHandle, guestNick, directory, auth, open }: {
  mode: 'guest' | 'account';
  authedHandle: string | null;
  guestNick: string;
  directory: DirectoryService;
  auth: AuthService;
  open: boolean;
}) {
  return (
    <SectionFrame
      title="Profile"
      description={mode === 'guest'
        ? 'The name people see you as in chat.'
        : 'How people find you on Boson, and your name in chat.'}
    >
      <div class="user-settings-stack">
        {mode === 'account' ? (
          <>
            <AvatarSettings handle={authedHandle ?? ''} directory={directory} auth={auth} open={open} />
            <Divider />
            <AccountHandleForm authedHandle={authedHandle} directory={directory} auth={auth} open={open} />
          </>
        ) : (
          <>
            <GuestNickForm guestNick={guestNick} />
            <Divider />
            <DetailRow label="Account" customValue={<Badge tone="info">Guest, no account</Badge>} />
          </>
        )}
      </div>
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
        hint="Changes right away on the servers you're on. Spaces, @ and dots are left out."
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

// Editable global handle for signed-in users. Fetches the authoritative
// value from /me on mount (and whenever the modal re-opens) so a stale
// session user_metadata cache can't pin the field to the wrong value.
// On save: PATCH /me first, then mirror the new handle into the session's
// user_metadata cache so the TitleBar and the rest of the app pick it up
// without a reload.
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
    const problem = validateHandle(trimmed);
    if (problem) { setError(problem); return; }
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
      // It's the nick too: renamed on the servers the user is on, now.
      emitHandleChange(updated.handle);
      triggerSaved();
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 400 || err.status === 409) setError(describeHandleError(err));
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
        hint="Renames you right away on the servers you're on. Your old handle keeps pointing to you for 90 days."
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
