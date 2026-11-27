import { useEffect, useState } from 'preact/hooks';
import { Badge, Button, ListRow } from '@boson/shared';
import { LeaveGuestConfirm } from '../../components/LeaveGuestConfirm';
import type { DirectoryService } from '../../modules/directory';
import type { IdentityService } from '../../modules/identity';
import { describeAuthError, type AuthService, type LinkedIdentities } from '../../modules/auth';
import { RecoveryCodeReveal } from '../../components/RecoveryCodeReveal';
import { SectionFrame, SettingRow, SettingsGroup } from './SettingsFrame';
import { useHomeNetwork } from '../../modules/netauth/home-network';

// Settings → Account & security: how you sign in (email, recovery code,
// linked "Sign in with …" identities) and signing out of this device. As a
// guest, the way to a boson.chat account instead.
export function AccountSection({ mode, authedEmail, onSignOut, onClose, directory, identity, auth, open }: {
  mode: 'guest' | 'account';
  authedEmail: string | null;
  onSignOut: () => void;
  onClose: () => void;
  directory: DirectoryService;
  identity: IdentityService;
  auth: AuthService;
  open: boolean;
}) {
  if (mode === 'guest') return <GuestAccountSection onClose={onClose} />;
  return (
    <SectionFrame title="Account & security" description="How you sign in to your Boson account.">
      <SettingsGroup title="Sign-in">
        <SettingRow
          class="user-settings-email"
          title="Email"
          description={<span class="user-settings-mono-value">{authedEmail ?? '—'}</span>}
        />
        <RecoveryCodeSettings directory={directory} identity={identity} open={open} />
      </SettingsGroup>
      <LinkedSignIns auth={auth} open={open} />
      <SettingsGroup title="This device">
        <SettingRow title="Sign out" description="Clears your Boson data from this device and returns to the login screen.">
          <Button variant="secondary" size="sm" onClick={() => { onSignOut(); onClose(); }}>Sign out</Button>
        </SettingRow>
      </SettingsGroup>
    </SectionFrame>
  );
}

// Guest mode's Account section: "Switch to an account" asks first, since
// leaving guest mode erases the guest's data on this device.
function GuestAccountSection({ onClose }: { onClose: () => void }) {
  const home = useHomeNetwork();
  const [confirm, setConfirm] = useState(false);
  return (
    <SectionFrame
      title="Account"
      description={`You're using Boson without a ${home.name} account (accounts on other networks are under Network accounts).`}
    >
      <SettingsGroup>
        <SettingRow
          title="Boson account"
          description="Register servers, keep an identity key and sync your settings across devices."
        >
          <Button variant="primary" size="sm" onClick={() => setConfirm(true)}>Switch to an account</Button>
        </SettingRow>
      </SettingsGroup>
      <LeaveGuestConfirm open={confirm} onCancel={() => setConfirm(false)} onLeave={() => { setConfirm(false); onClose(); }} />
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
    <SettingsGroup
      title="Linked sign-ins"
      description={data.has_password ? 'You can also sign in with your password.' : 'This account has no password: these are the ways in.'}
      class="user-settings-identities"
    >
      <ul class="settings-rows" aria-label="Linked sign-ins">
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
    </SettingsGroup>
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
      <div class="user-settings-recovery">
        <RecoveryCodeReveal
          code={revealCode}
          intro="This replaces any previous recovery code. It's the only way back into
            your synced passwords if you forget your login password — save it now."
          continueLabel="Done"
          onContinue={() => setRevealCode(null)}
        />
      </div>
    );
  }

  const action = hasRecovery ? 'Regenerate' : 'Set up';
  return (
    <div class="user-settings-recovery">
      <SettingRow
        title="Recovery code"
        meta={hasRecovery === null
          ? null
          : hasRecovery
            ? <Badge tone="verified">Enabled</Badge>
            : <Badge tone="warn">Not set up</Badge>}
        description="Your password unlocks your identity key, which signs you in to IRC servers and protects the passwords Boson syncs. After a password reset, this code unlocks it once."
      >
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy}
          aria-label={`${action} recovery code`}
          onClick={() => { void enroll(); }}
        >
          {busy ? 'Working…' : action}
        </Button>
      </SettingRow>
      {error && <div class="user-settings-error">{error}</div>}
    </div>
  );
}
