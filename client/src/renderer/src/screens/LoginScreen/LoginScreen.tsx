import { useEffect, useMemo, useState } from 'preact/hooks';
import { useAuthService } from '../../modules/auth';
import type { DirectoryService } from '../../modules/directory';
import type { IdentityService } from '../../modules/identity';
import { Button, Card, Field, Input, Logo, Tabs, WarningBanner } from '@boson/shared';
import { LoginBloc, type LoginMode } from './LoginBloc';
import { emitGuestChange, saveGuestSession } from '../../modules/guest/guest';
import { sanitizeIrcNick } from '../../modules/identity/nick';
import './LoginScreen.css';

interface Props {
  directory: DirectoryService;
  identity: IdentityService;
}

export function LoginScreen({ directory, identity }: Props) {
  const auth = useAuthService();
  const bloc = useMemo(() => new LoginBloc({ auth, directory, identity }), [auth, directory, identity]);
  const [state, setState] = useState(() => bloc.getState());
  useEffect(() => bloc.subscribe(setState), [bloc]);

  const { mode, email, password, confirmPassword, error, unrecoverable, busy } = state;

  // Guest-mode local state. The user clicks "Continue as guest" to reveal a
  // single nick field; submitting it writes a localStorage record and emits
  // an event that the App router picks up to swap into the directory.
  const [guestPrompt, setGuestPrompt] = useState(false);
  const [guestNick, setGuestNick] = useState('');

  const onSubmit = (kind: 'signin' | 'signup', e: Event) => {
    e.preventDefault();
    void (kind === 'signin' ? bloc.signIn() : bloc.signUp());
  };

  const submitGuest = (e: Event): void => {
    e.preventDefault();
    const nick = sanitizeIrcNick(guestNick.trim());
    if (!nick) return;
    saveGuestSession({ nick });
    emitGuestChange();
  };

  return (
    <div class="login-screen">
      <div class="login-container">
        <Logo />

        <Tabs
          tabs={[
            { id: 'login', label: 'Login' },
            { id: 'signup', label: 'Signup' },
          ]}
          active={mode}
          onChange={(id) => bloc.setMode(id as LoginMode)}
        />

        <Card>
          <form onSubmit={(e) => onSubmit(mode === 'signup' ? 'signup' : 'signin', e)}>
            <Field label="Email">
              <Input
                type="email"
                placeholder="email"
                value={email}
                onInput={(e) => bloc.setEmail((e.target as HTMLInputElement).value)}
                autoFocus
                required
                autoComplete="username"
              />
            </Field>

            <Field
              label="Password"
              hint={mode === 'login'
                ? 'This unlocks your identity key from the keychain.'
                : 'This encrypts your identity key. Lose it → lose access to all servers.'}
            >
              <Input
                type="password"
                placeholder="password"
                value={password}
                onInput={(e) => bloc.setPassword((e.target as HTMLInputElement).value)}
                required
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
            </Field>

            {mode === 'signup' && (
              <Field label="Confirm password">
                <Input
                  type="password"
                  placeholder="confirm password"
                  value={confirmPassword}
                  onInput={(e) => bloc.setConfirmPassword((e.target as HTMLInputElement).value)}
                  required
                  autoComplete="new-password"
                />
              </Field>
            )}

            {error && (
              <div class="login-error" role="alert">
                {error}
                {unrecoverable && (
                  <div class="login-error-action">
                    <Button
                      type="button"
                      variant="primary"
                      disabled={busy}
                      loading={busy}
                      onClick={() => { void bloc.startFresh(); }}
                    >
                      Start fresh
                    </Button>
                  </div>
                )}
              </div>
            )}

            <div class="login-actions">
              <Button
                type={mode === 'login' ? 'submit' : 'button'}
                variant={mode === 'login' ? 'primary' : 'ghost'}
                fullWidth
                disabled={busy}
                loading={busy && mode === 'login'}
                onClick={(e) => onSubmit('signin', e)}
              >
                Sign in
              </Button>
              <Button
                type={mode === 'signup' ? 'submit' : 'button'}
                variant={mode === 'signup' ? 'primary' : 'ghost'}
                fullWidth
                disabled={busy}
                loading={busy && mode === 'signup'}
                onClick={(e) => onSubmit('signup', e)}
              >
                Sign up
              </Button>
            </div>

            {mode === 'signup' && (
              <WarningBanner tone="warn" title="No password recovery">
                Your identity key is encrypted with your password. If you forget it, you'll need to reclaim each server identity via NickServ or admin contact.
              </WarningBanner>
            )}
          </form>
        </Card>

        <div class="login-guest">
          {!guestPrompt ? (
            <button
              type="button"
              class="login-guest-toggle"
              onClick={() => setGuestPrompt(true)}
            >
              Continue without an account
            </button>
          ) : (
            <form onSubmit={submitGuest} class="login-guest-form">
              <Field
                label="Pick a nick"
                hint="Used as your IRC nickname. No account; data stays on this device."
              >
                <Input
                  placeholder="your-nick"
                  value={guestNick}
                  onInput={(e) => setGuestNick((e.target as HTMLInputElement).value)}
                  autoFocus
                  required
                  autoComplete="off"
                  spellcheck={false}
                />
              </Field>
              <div class="login-guest-actions">
                <Button type="button" variant="ghost" onClick={() => setGuestPrompt(false)}>Back</Button>
                <Button type="submit" variant="primary" disabled={!guestNick.trim()}>
                  Continue
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
