import {
  AuthError, SSO_CANCELLED, describeAuthError, signInWithProvider, ssoBridge, validateUsername,
  type AuthService, type SSOBridge, type SSOProvider,
} from '../../modules/auth';
import type { DirectoryService } from '../../modules/directory';
import type { IdentityService } from '../../modules/identity';
import { HttpError } from '../../shared/http/http.client';

export type LoginMode = 'login' | 'signup';

export interface LoginState {
  mode: LoginMode;
  // Sign-in: username or email.
  login: string;
  // Sign-up: the account username (an IRC nick) and email. `email` is also
  // what "Forgot password?" and "Resend email" send to.
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
  busy: boolean;
  error: string | null;
  // Non-null means the stored encrypted_user_secret is unrecoverable — the
  // view shows the destructive "Start fresh" button.
  unrecoverable: string | null;
  // Non-null (the recovery wrap, base64) means a password unlock failed BUT
  // the account has a recovery wrap — the view offers a "Use recovery code"
  // input. Set after a wrong-password unlock when me.encrypted_user_secret_
  // recovery is present (typically after a password reset).
  recoverable: string | null;
  // Set after a sign-up that needs email verification, or a sign-in the
  // auth service refused with email_not_verified: the address the link went
  // to ('' when the user signed in by username, so we don't know it). The
  // view swaps the form for a "Check your email" panel: open the link (it
  // opens the auth service's page in the browser), then Continue signs in.
  awaitingConfirmation: string | null;
  // The "Forgot password?" panel is open.
  forgotOpen: boolean;
  // A non-error message (reset or verification email sent).
  notice: string | null;
  // "Sign in with …" buttons (empty: none, or not the desktop app).
  ssoProviders: SSOProvider[];
  // The provider whose browser sign-in is under way.
  ssoPending: string | null;
  // Signed in through a provider, but the identity key needs a passphrase:
  // 'unlock' (the account has a key: the password it was made with) or
  // 'create' (a new account: pick one). A keychain copy skips this.
  identityPrompt: 'unlock' | 'create' | null;
}

export type LoginListener = (state: LoginState) => void;

export interface LoginBlocDeps {
  auth: AuthService;
  directory: DirectoryService;
  identity: IdentityService;
  // The desktop app's loopback listener; default window.bosonSSO.
  sso?: SSOBridge | null;
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
    login: '',
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
    busy: false,
    error: null,
    unrecoverable: null,
    recoverable: null,
    awaitingConfirmation: null,
    forgotOpen: false,
    notice: null,
    ssoProviders: [],
    ssoPending: null,
    identityPrompt: null,
  };

  private readonly sso: SSOBridge | null;
  private ssoFlow: { cancel(): void } | null = null;

  constructor(deps: LoginBlocDeps) {
    this.auth = deps.auth;
    this.directory = deps.directory;
    this.identity = deps.identity;
    this.sso = deps.sso === undefined ? ssoBridge() : deps.sso;
  }

  // Fetches the identity providers for the "Sign in with …" buttons. Only
  // in the desktop app (it receives the browser's redirect); a failure just
  // leaves the buttons off.
  async loadProviders(): Promise<void> {
    if (!this.sso || typeof this.auth.config !== 'function') return;
    try {
      const cfg = await this.auth.config();
      this.setState({ ...this.state, ssoProviders: cfg.sso_providers });
    } catch (err) {
      console.warn('[login] could not load sign-in providers', err);
    }
  }

  // "Sign in with <provider>": the browser does the provider's login; then
  // the identity key comes from the keychain, or needs its passphrase.
  async signInWith(slug: string): Promise<void> {
    const provider = this.state.ssoProviders.find((p) => p.slug === slug);
    if (!provider || !this.sso || this.state.busy) return;
    this.setState({ ...this.state, error: null, notice: null, unrecoverable: null, recoverable: null, busy: true, ssoPending: slug });
    const flow = signInWithProvider(this.auth, this.sso, provider);
    this.ssoFlow = flow;
    let userId: string;
    try {
      userId = (await flow.done).user.id;
    } catch (err) {
      if (this.ssoFlow !== flow) return;
      this.ssoFlow = null;
      const cancelled = err instanceof AuthError && err.code === SSO_CANCELLED;
      this.setState({ ...this.state, busy: false, ssoPending: null, error: cancelled ? null : describeAuthError(err) });
      return;
    }
    this.ssoFlow = null;
    try {
      // This device may hold the key already.
      if (await this.identity.restoreFromStorage(userId)) {
        this.setState({ ...this.state, busy: false, ssoPending: null });
        return;
      }
      let me;
      try {
        me = await this.directory.getMe();
      } catch (err) {
        if (!(err instanceof HttpError) || err.status !== 404) throw err;
      }
      this.setState({
        ...this.state, busy: false, ssoPending: null, password: '', confirmPassword: '',
        identityPrompt: me?.encrypted_user_secret ? 'unlock' : 'create',
      });
    } catch (err) {
      this.setState({ ...this.state, busy: false, ssoPending: null, error: describeAuthError(err) });
    }
  }

  // Stop waiting for the browser.
  cancelSignInWith(): void {
    const flow = this.ssoFlow;
    this.ssoFlow = null;
    flow?.cancel();
    this.setState({ ...this.state, busy: false, ssoPending: null });
  }

  // The passphrase step after a provider sign-in.
  async submitIdentityPassphrase(): Promise<void> {
    const { identityPrompt, password, confirmPassword } = this.state;
    if (!identityPrompt || !password) return;
    if (identityPrompt === 'create' && password !== confirmPassword) {
      this.setState({ ...this.state, error: "Passphrases don't match." });
      return;
    }
    this.setState({ ...this.state, error: null, notice: null, unrecoverable: null, recoverable: null, busy: true });
    try {
      if (await this.unlockIdentity(password)) {
        this.setState({ ...this.state, busy: false, identityPrompt: null });
      }
    } catch (err) {
      this.setState({ ...this.state, error: describeAuthError(err), busy: false });
    }
  }

  // Back out of the passphrase step: signs the provider session out.
  async abandonIdentityPrompt(): Promise<void> {
    this.setState({ ...this.state, identityPrompt: null, password: '', confirmPassword: '', error: null, recoverable: null, unrecoverable: null });
    await this.auth.signOut().catch(() => {});
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
    this.setState({ ...this.state, mode, error: null, notice: null });
  }

  setLogin(login: string): void {
    if (this.state.login === login) return;
    this.setState({ ...this.state, login });
  }

  setUsername(username: string): void {
    if (this.state.username === username) return;
    this.setState({ ...this.state, username });
  }

  // Live feedback for the sign-up username field (null = fine or empty).
  usernameProblem(): string | null {
    return this.state.username ? validateUsername(this.state.username) : null;
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
    const { login, password } = this.state;
    this.setState({ ...this.state, error: null, notice: null, unrecoverable: null, recoverable: null, busy: true });
    try {
      try {
        await this.auth.signIn(login, password);
      } catch (err) {
        if (err instanceof AuthError && err.code === 'email_not_verified') {
          const email = login.includes('@') ? login.trim() : this.state.email;
          this.setState({ ...this.state, busy: false, awaitingConfirmation: email, email });
          return;
        }
        throw err;
      }
      if (!(await this.unlockIdentity(password))) return;
      this.setState({ ...this.state, busy: false, awaitingConfirmation: null });
    } catch (err) {
      this.setState({
        ...this.state,
        error: describeAuthError(err),
        busy: false,
      });
    }
  }

  // Unlocks the identity key with `password` (the account's existing key),
  // or makes one for a new account, and keeps it in the keychain. false
  // (with the error in state) when the password didn't unlock it.
  private async unlockIdentity(password: string): Promise<boolean> {
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
        } else if (me.encrypted_user_secret_recovery) {
          // Wrong password, but the account has a recovery wrap — offer the
          // recovery-code path (the usual case after a password reset,
          // which leaves the password wrap stale).
          this.setState({
            ...this.state,
            recoverable: me.encrypted_user_secret_recovery,
            error:
              "Couldn't decrypt your identity key with that password. " +
              'If you reset your password, enter your recovery code below.',
            busy: false,
          });
        } else {
          this.setState({
            ...this.state,
            error: `Couldn't decrypt your identity key. Use the same password you signed up with. (${detail})`,
            busy: false,
          });
        }
        return false;
      }
    } else {
      await this.identity.initializeForNewUser(password);
    }
    // Identity is unlocked. Best-effort persist to the OS keychain so the
    // next launch skips the password prompt. Never blocks the sign-in flow;
    // identity.persist() returns false rather than throwing.
    await this.persistIdentity();
    return true;
  }

  async signUp(): Promise<void> {
    const { username, email, password, confirmPassword } = this.state;
    // Local validation runs before we touch the network. Confirm-password is
    // optional (only enforced when the user typed one).
    const nameProblem = validateUsername(username.trim());
    if (nameProblem) {
      this.setState({ ...this.state, error: `Username: ${nameProblem}`, unrecoverable: null });
      return;
    }
    if (confirmPassword && password !== confirmPassword) {
      this.setState({ ...this.state, error: "Passwords don't match.", unrecoverable: null });
      return;
    }
    this.setState({ ...this.state, busy: true, error: null, notice: null, unrecoverable: null });
    try {
      const { verificationRequired } = await this.auth.signUp({ username: username.trim(), email, password });
      if (verificationRequired) {
        // The auth service emailed a verification link. Sign-in works once
        // it's opened; Continue on the panel signs in with these details.
        this.setState({
          ...this.state,
          busy: false,
          login: username.trim(),
          awaitingConfirmation: email.trim(),
        });
        return;
      }
      // Verification off (local dev): signUp already signed in. Create the
      // identity now so the SetupPrompt path takes over on the directory.
      await this.identity.initializeForNewUser(password);
      await this.persistIdentity();
      this.setState({ ...this.state, busy: false });
    } catch (err) {
      this.setState({
        ...this.state,
        error: describeAuthError(err),
        busy: false,
      });
    }
  }

  // "Check your email" → Continue: the link was opened in the browser, so
  // try signing in with what the user typed.
  async continueAfterVerification(): Promise<void> {
    if (!this.state.password || !this.state.login) {
      this.setState({ ...this.state, awaitingConfirmation: null, mode: 'login', error: null });
      return;
    }
    this.setState({ ...this.state, mode: 'login' });
    await this.signIn();
    if (this.state.awaitingConfirmation !== null) {
      this.setState({ ...this.state, error: 'Not verified yet — open the link in the email first.' });
    }
  }

  async resendVerification(): Promise<void> {
    const email = this.state.email.trim();
    if (!email) {
      this.setState({ ...this.state, error: 'Enter the email address you signed up with.' });
      return;
    }
    this.setState({ ...this.state, busy: true, error: null, notice: null });
    try {
      await this.auth.resendVerification(email);
      this.setState({ ...this.state, busy: false, awaitingConfirmation: email, notice: `Sent a new link to ${email}.` });
    } catch (err) {
      this.setState({ ...this.state, busy: false, error: describeAuthError(err) });
    }
  }

  // View-driven exit from the "Check your email" panel. Keeps what was
  // typed so the user can fix the address and retry.
  cancelAwaitingConfirmation(): void {
    this.setState({ ...this.state, awaitingConfirmation: null, error: null, notice: null });
  }

  openForgot(): void {
    const { login } = this.state;
    const email = this.state.email || (login.includes('@') ? login.trim() : '');
    this.setState({ ...this.state, forgotOpen: true, email, error: null, notice: null });
  }

  closeForgot(): void {
    this.setState({ ...this.state, forgotOpen: false, error: null });
  }

  // Emails a reset link; it opens the auth service's reset page in the
  // browser. Same answer whether or not the account exists.
  async sendPasswordReset(): Promise<void> {
    const email = this.state.email.trim();
    if (!email.includes('@')) {
      this.setState({ ...this.state, error: 'Enter your account email address.' });
      return;
    }
    this.setState({ ...this.state, busy: true, error: null, notice: null });
    try {
      await this.auth.requestPasswordReset(email);
      this.setState({
        ...this.state,
        busy: false,
        forgotOpen: false,
        notice:
          `If ${email} has an account, a reset link is on its way. Set a new password there, then sign in here — ` +
          "you'll need your recovery code once to unlock your identity key.",
      });
    } catch (err) {
      this.setState({ ...this.state, busy: false, error: describeAuthError(err) });
    }
  }

  async startFresh(): Promise<void> {
    const { password, unrecoverable } = this.state;
    this.setState({ ...this.state, busy: true, error: null, unrecoverable: null });
    try {
      // Auth from the failed unlock still has a valid session, so
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

  // Recovery path: the user signed in (with a possibly-reset password) but the
  // password wrap wouldn't decrypt, and the account has a recovery wrap. Unlock
  // user_secret with the recovery CODE, then re-wrap it under the current
  // password and persist that wrap so future logins work normally again.
  async recoverWithCode(recoveryCode: string): Promise<void> {
    const recoveryBlob = this.state.recoverable;
    if (!recoveryBlob) return;
    const code = recoveryCode.trim();
    if (!code) {
      this.setState({ ...this.state, error: 'Enter your recovery code.' });
      return;
    }
    this.setState({ ...this.state, busy: true, error: null });
    try {
      await this.identity.unlockWithRecoveryCode(code, recoveryBlob);
      // Re-wrap under the password they just used so the normal password path
      // works next time. Best-effort persist of the new wrap to the backend.
      try {
        const passwordBlob = await this.identity.rewrapForNewPassword(this.state.password);
        await this.directory.updateSecretWraps({ passwordBlob });
      } catch (rewrapErr) {
        // Identity is already unlocked; a failed re-wrap just means they'll
        // need the recovery code again next time. Don't block the session.
        console.warn('[LoginBloc.recoverWithCode] re-wrap failed:', rewrapErr);
      }
      await this.persistIdentity();
      // Identity is unlocked → Router routes to DirectoryScreen.
      this.setState({ ...this.state, busy: false, recoverable: null, error: null });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.setState({
        ...this.state,
        busy: false,
        error: `Recovery code rejected. Check it and try again. (${detail})`,
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
