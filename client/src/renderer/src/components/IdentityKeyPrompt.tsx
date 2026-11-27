import { useEffect, useState } from 'preact/hooks';
import { Button, Field, Input, Modal } from '@boson/shared';
import type { IdentityService } from '../modules/identity';
import type { AuthService } from '../modules/auth';
import type { DirectoryService } from '../modules/directory';
import type { HomeAccountData, HomeAccountHandle } from '../modules/netauth/home-account';
import {
  KEY_REASONS, currentKeyRequest, onKeyRequest, rememberHomeKeyId, settleKeyRequest, type KeyRequest,
} from '../modules/identity/key-request';
import { PASSWORD_MIN } from '../modules/auth/signup-rules';
import { RecoveryCodeReveal } from './RecoveryCodeReveal';


// The identity key, asked for when a passwordless session first needs it
// (modules/identity/key-request.ts). Federated: unlock the home account's
// key with its passphrase, or set one up at the home account when it has
// none. Signed in through an identity provider (SSO): the same with this
// account's own key, on this server; an account that also has a password
// unlocks it with that. Mounted once, in the app shell.
type Step =
  | { kind: 'loading' }
  | { kind: 'no-home'; homeDomain: string }
  | { kind: 'unlock'; home: HomeAccountHandle; blob: string }
  | { kind: 'create'; home: HomeAccountHandle; exists: boolean }
  | { kind: 'reveal'; code: string };

export function IdentityKeyPrompt({ identity, homeData, directory, auth }: {
  identity: IdentityService;
  homeData: HomeAccountData;
  // This app's own account (an SSO session's key is kept with it).
  directory?: DirectoryService;
  auth?: AuthService;
}) {
  const [req, setReq] = useState<KeyRequest | null>(currentKeyRequest());
  useEffect(() => onKeyRequest(setReq), []);
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!req) return;
    setPass(''); setConfirm(''); setError(null); setBusy(false);
    setStep({ kind: 'loading' });
    let live = true;
    void (async () => {
      const own = ownAccount(auth, directory);
      const home = own ?? await homeData.home().catch(() => null);
      if (!live) return;
      if (!home) {
        setStep({ kind: 'no-home', homeDomain: homeData.federated()?.homeDomain ?? '' });
        return;
      }
      try {
        const me = await home.directory.getMe();
        if (!live) return;
        setStep(me?.encrypted_user_secret
          ? { kind: 'unlock', home, blob: me.encrypted_user_secret }
          : { kind: 'create', home, exists: !!me });
      } catch {
        if (live) setStep({ kind: 'no-home', homeDomain: home.homeDomain });
      }
    })();
    return () => { live = false; };
  }, [req, homeData, auth, directory]);

  if (!req) return null;
  const why = KEY_REASONS[req.reason];
  const close = (): void => settleKeyRequest(identity.isUnlocked());
  const sso = !homeData.federated() ? auth?.getState().session?.sso ?? null : null;
  const identityName = homeData.federated()?.identity ?? '';

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (step.kind === 'unlock') {
      setBusy(true);
      try {
        await identity.unlock(pass, step.blob);
      } catch {
        setError(sso
          ? "That didn't unlock your key. Use your Boson password, or the identity passphrase you set."
          : "That passphrase didn't unlock your key. Use the one for your account there.");
        setBusy(false);
        return;
      }
      rememberHomeKeyId(step.home.userId);
      await identity.persist(step.home.userId);
      setBusy(false);
      settleKeyRequest(true);
      return;
    }
    if (step.kind === 'create') {
      if (pass.length < PASSWORD_MIN) { setError(`Use at least ${PASSWORD_MIN} characters.`); return; }
      if (pass !== confirm) { setError("Passphrases don't match."); return; }
      setBusy(true);
      try {
        const encrypted = await identity.initializeForNewUser(pass);
        const recovery = identity.getPendingRecovery();
        if (step.exists) {
          await step.home.directory.updateSecretWraps({ passwordBlob: encrypted, ...(recovery ? { recoveryBlob: recovery.recoveryBlob } : {}) });
        } else {
          const handle = step.home.auth.getState().session?.user.username || identityName.split('@')[0] || '';
          await step.home.directory.setupMe(handle, encrypted, recovery?.recoveryBlob);
        }
        identity.clearPendingEncrypted();
        rememberHomeKeyId(step.home.userId);
        await identity.persist(step.home.userId);
        setBusy(false);
        if (recovery?.recoveryCode) setStep({ kind: 'reveal', code: recovery.recoveryCode });
        else settleKeyRequest(true);
      } catch {
        // Not saved at the home: no key nobody else has.
        identity.lock();
        setBusy(false);
        setError(sso ? "Couldn't save the key to your account. Try again." : `Couldn't save the key to ${step.home.homeDomain}. Try again.`);
      }
    }
  };

  const title = step.kind === 'create' ? 'Set up your identity key'
    : step.kind === 'reveal' ? 'Save your recovery code'
    : step.kind === 'loading' ? 'Your identity key'
    : 'Unlock your identity key';
  return (
    <Modal open onClose={close} title={title} size="compact" class="identity-key-prompt-modal">
      <div class="identity-key-prompt">
        {step.kind === 'loading' && <p class="identity-key-prompt-body">Checking your account…</p>}
        {step.kind === 'no-home' && (
          <>
            {sso ? (
              <p class="identity-key-prompt-body">
                Boson needs your identity key {why}, but couldn't reach your account just now. Try again in a moment.
              </p>
            ) : (
              <p class="identity-key-prompt-body">
                Boson needs your identity key {why}. It belongs to {identityName || 'your account'}, so
                sign in to {step.homeDomain || 'your home server'} in this browser first, then try again.
              </p>
            )}
            <div class="identity-key-prompt-actions">
              <Button variant="primary" onClick={close}>OK</Button>
            </div>
          </>
        )}
        {step.kind === 'reveal' && (
          <RecoveryCodeReveal
            code={step.code}
            intro="If you forget the passphrase, this code is the only way back into your key. Keep it somewhere safe."
            onContinue={() => settleKeyRequest(true)}
          />
        )}
        {(step.kind === 'unlock' || step.kind === 'create') && (
          <form onSubmit={(e) => { void submit(e); }}>
            {sso ? (
              <p class="identity-key-prompt-body">
                Boson needs your identity key {why}. You signed in with {sso.provider}, so it hasn't been unlocked on this device.
                {step.kind === 'unlock'
                  ? ' Enter your Boson password (or the identity passphrase you set) once on this device.'
                  : " Your account doesn't have one yet: pick a passphrase to protect it. You enter it once on each new device."}
              </p>
            ) : (
              <p class="identity-key-prompt-body">
                Boson needs your identity key {why}. You're signed in here with{' '}
                <strong>{identityName}</strong>; the key is kept with that account at {step.home.homeDomain}.
                {step.kind === 'unlock'
                  ? ' Enter its password (or the identity passphrase you set there) once on this device.'
                  : " It doesn't have one yet: pick a passphrase to protect it. You enter it once on each new device."}
              </p>
            )}
            <Field label={step.kind === 'unlock' ? 'Password or passphrase' : 'Passphrase'}>
              <Input
                type="password"
                value={pass}
                onInput={(e) => setPass((e.target as HTMLInputElement).value)}
                autoFocus
                required
                autoComplete={step.kind === 'unlock' ? 'current-password' : 'new-password'}
              />
            </Field>
            {step.kind === 'create' && (
              <Field label="Confirm passphrase">
                <Input
                  type="password"
                  value={confirm}
                  onInput={(e) => setConfirm((e.target as HTMLInputElement).value)}
                  required
                  autoComplete="new-password"
                />
              </Field>
            )}
            {error && <div class="identity-key-prompt-error" role="alert">{error}</div>}
            <div class="identity-key-prompt-actions">
              <Button type="button" variant="ghost" onClick={close} disabled={busy}>Not now</Button>
              <Button type="submit" variant="primary" disabled={busy || !pass}>
                {step.kind === 'unlock' ? 'Unlock' : 'Set up key'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}

// An SSO session's key is this account's own: its blob in this server's /me,
// kept on this device under its own user id. null for a federated session
// (the home account's) or without a session.
function ownAccount(auth: AuthService | undefined, directory: DirectoryService | undefined): HomeAccountHandle | null {
  const s = auth?.getState().session;
  if (!auth || !directory || !s || s.federated || !s.sso) return null;
  return {
    auth,
    directory,
    userId: s.user.id,
    identity: s.user.username || s.user.email || '',
    homeDomain: '',
  };
}
