import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';

export interface AuthState {
  session: Session | null;
  loading: boolean;
  error: string | null;
}

export type AuthListener = (state: AuthState) => void;

export class AuthService {
  private readonly supabase: SupabaseClient;
  private state: AuthState = { session: null, loading: true, error: null };
  private readonly listeners = new Set<AuthListener>();

  constructor(supabaseUrl: string, anonKey: string) {
    this.supabase = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }

  async init(): Promise<void> {
    const { data, error } = await this.supabase.auth.getSession();
    if (error) {
      this.setState({ session: null, loading: false, error: error.message });
      return;
    }
    this.setState({ session: data.session, loading: false, error: null });

    this.supabase.auth.onAuthStateChange((_event, session) => {
      this.setState({ session, loading: false, error: null });
    });
  }

  markFatal(message: string): void {
    this.setState({ ...this.state, loading: false, error: message });
  }

  async signIn(email: string, password: string): Promise<void> {
    const { error } = await this.supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }

  async signUp(email: string, password: string): Promise<void> {
    // Supabase emails the user a confirmation link. We point that link
    // at the marketing site's /auth/confirmed page, which immediately
    // forwards the tokens to the desktop app via boson:// deep-link
    // (see website/src/pages/AuthConfirmedPage.tsx and the AuthConfirmed
    // handler in the renderer's deep-link module). The marketing site
    // also serves as the install fallback when Boson isn't on the
    // user's machine yet.
    const { error } = await this.supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: 'https://boson.chat/auth/confirmed' },
    });
    if (error) throw error;
  }

  // Hydrate a Supabase session from tokens handed to us via a
  // boson://auth/confirmed deep-link. The website /auth/confirmed
  // page forwards Supabase's redirect fragment verbatim, so we
  // already have a complete (access_token, refresh_token) pair to
  // feed setSession with.
  //
  // Returns the session on success so callers can react (e.g. route
  // away from the sign-in screen) without having to wait for the
  // onAuthStateChange callback to fire.
  async setSessionFromTokens(accessToken: string, refreshToken: string): Promise<Session> {
    const { data, error } = await this.supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error) throw error;
    if (!data.session) throw new Error('setSession returned no session');
    return data.session;
  }

  // PKCE alternative — the boson://auth/confirmed deep-link can also
  // carry a `?code=...` instead of fragment tokens, depending on the
  // client's flowType. Supabase's auth library does the actual
  // exchange against its own backend and writes the session to local
  // storage if persistSession is on (it is, see the constructor).
  async exchangeAuthCode(code: string): Promise<Session> {
    const { data, error } = await this.supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    if (!data.session) throw new Error('exchangeCodeForSession returned no session');
    return data.session;
  }

  async signOut(): Promise<void> {
    await this.supabase.auth.signOut();
  }

  // Mirror a field into Supabase user_metadata so consumers reading
  // `session.user.user_metadata.<field>` (title bar, settings, etc.)
  // pick up the change immediately via the onAuthStateChange callback
  // — no page reload required. Backend remains the source of truth
  // for persistent state; this is just the renderer's cache key.
  async updateMetadata(data: Record<string, unknown>): Promise<void> {
    const { error } = await this.supabase.auth.updateUser({ data });
    if (error) throw error;
  }

  async getToken(): Promise<string | null> {
    return this.state.session?.access_token ?? null;
  }

  getState(): AuthState {
    return this.state;
  }

  subscribe(fn: AuthListener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }

  private setState(next: AuthState): void {
    this.state = next;
    this.listeners.forEach(fn => fn(next));
  }
}
