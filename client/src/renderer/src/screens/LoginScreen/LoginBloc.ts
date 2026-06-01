import type { AuthService } from '../../modules/auth';
import type { DirectoryService } from '../../modules/directory';
import type { IdentityService } from '../../modules/identity';
import { HttpError } from '../../shared/http/http.client';

export type LoginMode = 'login' | 'signup';

export interface LoginState {
  mode: LoginMode;
  email: string;
  password: string;
  confirmPassword: string;
  busy: boolean;
  error: string | null;
  // Non-null means the stored encrypted_user_secret is unrecoverable — the
  // view shows the destructive "Start fresh" button.
  unrecoverable: string | null;
  // Set to the email address after a successful signUp that needs
  // email confirmation. The view swaps the form for a "Check your
  // email" panel until the user either confirms (deep-link triggers
  // a session change → Router routes away) or clicks Back to retry
  // with a different address.
  awaitingConfirmation: string | null;
}

export type LoginListener = (state: LoginState) => void;

export interface LoginBlocDeps {
  auth: AuthService;
  directory: DirectoryService;
  identity: IdentityService;
}

// Substring used to detect a stored ciphertext that can't possibly be a valid
// AES-GCM blob (almost always leftover test-seed stub data). Surfacing the
// destructive "Start fresh" path on any other unlock error would mean wiping
// real accounts on a mistyped password — keep this match exact.
const UNRECOVERABLE_BLOB_MARKER = 'blob too short';

/**
 * LoginBloc owns all UI state and business logic for LoginScreen.
 * Following the project's BLoC convention:
 *   - state lives in private fields
 *   - getState() returns an immutable snapshot
 *   - subscribe() fires immediately with the current state and on every change
 *   - public methods are verbs (commands) wired to view inputs/buttons
 */
export class LoginBloc {
  private readonly auth: AuthService;
  private readonly directory: DirectoryService;
  private readonly identity: IdentityService;
  private readonly listeners = new Set<LoginListener>();

  private state: LoginState = {
    mode: 'login',
    email: '',
    password: '',
    confirmPassword: '',
    busy: false,
    error: null,
    unrecoverable: null,
    awaitingConfirmation: null,
  };

  constructor(deps: LoginBlocDeps) {
    this.auth = deps.auth;
    this.directory = deps.directory;
    this.identity = deps.identity;
  }

  getState(): LoginState {
    return this.state;
  }

  subscribe(fn: LoginListener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }

  // Field setters — view binds inputs to these.
  setMode(mode: LoginMode): void {
    if (this.state.mode === mode && this.state.error === null) return;
    // Switching tabs clears any error from the other mode so the user isn't
    // greeted by a stale "wrong password" message after flipping to Signup.
    this.setState({ ...this.state, mode, error: null });
  }

  setEmail(email: string): void {
    if (this.state.email === email) return;
    this.setState({ ...this.state, email });
  }

  setPassword(password: string): void {
    if (this.state.password === password) return;
    this.setState({ ...this.state, password });
  }

  setConfirmPassword(confirmPassword: string): void {
    if (this.state.confirmPassword === confirmPassword) return;
    this.setState({ ...this.state, confirmPassword });
  }

  async signIn(): Promise<void> {
    const { email, password } = this.state;
    this.setState({ ...this.state, error: null, unrecoverable: null, busy: true });
    try {
      await this.auth.signIn(email, password);
      let me;
      try {
        me = await this.directory.getMe();
      } catch (err) {
        if (!(err instanceof HttpError) || err.status !== 404) throw err;
      }
      if (me?.encrypted_user_secret) {
        try {
          await this.identity.unlock(password, me.encrypted_user_secret);
        } catch (unlockErr) {
          const detail = unlockErr instanceof Error ? unlockErr.message : String(unlockErr);
          console.error('[identity.unlock] failed:', detail, { blobLen: me.encrypted_user_secret.length });
          // "blob too short" means the stored ciphertext can't possibly be a
          // valid AES-GCM blob — almost always test-seed stub data. Offer the
          // Start-fresh path. Any other unlock error is most likely a wrong
          // password, where the right answer is "try again," not "wipe it."
          if (detail.includes(UNRECOVERABLE_BLOB_MARKER)) {
            this.setState({
              ...this.state,
              unrecoverable: detail,
              error:
                'Your stored identity key is invalid (likely leftover test data). ' +
                'Start fresh to recreate it — this wipes your current account row.',
              busy: false,
            });
          } else {
            this.setState({
              ...this.state,
              error: `Couldn't decrypt your identity key. Use the same password you signed up with. (${detail})`,
              busy: false,
            });
          }
          return;
        }
      } else {
        await this.identity.initializeForNewUser(password);
      }
      // Identity is unlocked. Best-effort persist to the OS keychain so the
      // next launch skips the password prompt. Never blocks the sign-in flow;
      // identity.persist() returns false rather than throwing.
      await this.persistIdentity();
      this.setState({ ...this.state, busy: false });
    } catch (err) {
      this.setState({
        ...this.state,
        error: err instanceof Error ? err.message : 'authentication failed',
        busy: false,
      });
    }
  }

  async signUp(): Promise<void> {
    const { email, password, confirmPassword } = this.state;
    // Local validation runs before we touch the network. Confirm-password is
    // optional (only enforced when the user typed one) so existing tests
    // that omit it still flow through.
    if (confirmPassword && password !== confirmPassword) {
      this.setState({ ...this.state, error: "Passwords don't match.", unrecoverable: null });
      return;
    }
    this.setState({ ...this.state, busy: true, error: null, unrecoverable: null });
    try {
      await this.auth.signUp(email, password);
      // Supabase's response depends on whether email confirmation is
      // ENABLED on the project:
      //
      //   Confirmation ON  → no session yet; user must click the
      //     emailed link. We show "Check your email" and wait for
      //     the deep-link → setSessionFromTokens → router moves on.
      //
      //   Confirmation OFF (local dev with `enable_confirmations =
      //     false`, or hosted projects with that toggle) → Supabase
      //     returns a session immediately and onAuthStateChange has
      //     already fired by the time we reach this line. If we just
      //     set awaitingConfirmation here, the user gets stuck on a
      //     "check your email" panel for an email that never comes,
      //     while the router sits at LoginScreen because identity
      //     isn't unlocked. Initialize the identity NOW so the
      //     SetupPrompt path takes over on the DirectoryScreen.
      const session = this.auth.getState().session;
      if (session) {
        await this.identity.initializeForNewUser(password);
        await this.persistIdentity();
        this.setState({ ...this.state, busy: false });
      } else {
        this.setState({
          ...this.state,
          busy: false,
          awaitingConfirmation: email,
        });
      }
    } catch (err) {
      this.setState({
        ...this.state,
        error: err instanceof Error ? err.message : 'authentication failed',
        busy: false,
      });
    }
  }

  // View-driven exit from the "Check your email" panel. The user might
  // have typed the wrong address or want to try a different account —
  // reset back to the form without nuking what they typed for `email`
  // so they can edit and re-submit.
  cancelAwaitingConfirmation(): void {
    this.setState({ ...this.state, awaitingConfirmation: null });
  }

  async startFresh(): Promise<void> {
    const { password, unrecoverable } = this.state;
    this.setState({ ...this.state, busy: true, error: null, unrecoverable: null });
    try {
      // Auth from the failed unlock still has a valid Supabase session, so
      // DELETE /me is authorized. The backend cascades through user_server_links
      // and handle_changes. After this the user looks brand-new to /me.
      await this.directory.deleteMe();
      // Generate fresh key material with the password the user already typed.
      // SetupPrompt will fire on DirectoryScreen (getMe → 404) and post the
      // new ciphertext.
      await this.identity.initializeForNewUser(password);
      await this.persistIdentity();
      // Router observes the now-unlocked identity and routes to DirectoryScreen.
      this.setState({ ...this.state, busy: false });
    } catch (err) {
      this.setState({
        ...this.state,
        error: err instanceof Error ? err.message : 'reset failed',
        unrecoverable, // keep the recovery button visible
        busy: false,
      });
    }
  }

  // Pull the authed user id off auth.getState() and ask the identity service
  // to persist its unlocked secret. Quiet no-op if either piece is missing —
  // the user can still sign in, they'll just re-type their password next
  // launch. Wrapped here so signIn / signUp / startFresh share one entry point.
  private async persistIdentity(): Promise<void> {
    try {
      const userId = this.auth.getState().session?.user?.id;
      if (!userId) return;
      await this.identity.persist(userId);
    } catch (err) {
      // Best-effort; identity persistence must never break sign-in.
      console.warn('[LoginBloc.persistIdentity] failed:', err);
    }
  }

  private setState(next: LoginState): void {
    this.state = next;
    this.listeners.forEach((fn) => fn(next));
  }
}
