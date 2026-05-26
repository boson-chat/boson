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
    const { error } = await this.supabase.auth.signUp({ email, password });
    if (error) throw error;
  }

  async signOut(): Promise<void> {
    await this.supabase.auth.signOut();
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
