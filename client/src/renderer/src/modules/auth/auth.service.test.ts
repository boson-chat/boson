import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the Supabase client at module level — AuthService delegates to it,
// so we replace it before importing the service under test.
const mockGetSession = vi.fn();
const mockOnAuthStateChange = vi.fn();
const mockSignIn = vi.fn();
const mockSignUp = vi.fn();
const mockSignOut = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      getSession: mockGetSession,
      onAuthStateChange: mockOnAuthStateChange,
      signInWithPassword: mockSignIn,
      signUp: mockSignUp,
      signOut: mockSignOut,
    },
  }),
}));

// AuthService imports the mocked supabase client.
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let svc: AuthService;

  beforeEach(() => {
    mockGetSession.mockReset();
    mockOnAuthStateChange.mockReset();
    mockSignIn.mockReset();
    mockSignUp.mockReset();
    mockSignOut.mockReset();
    svc = new AuthService('http://supabase', 'anon');
  });

  it('starts in loading state', () => {
    expect(svc.getState()).toEqual({ session: null, loading: true, error: null });
  });

  it('init() populates session on success', async () => {
    const session = { access_token: 'jwt', user: { id: 'u1' } };
    mockGetSession.mockResolvedValueOnce({ data: { session }, error: null });

    await svc.init();

    expect(svc.getState().loading).toBe(false);
    expect(svc.getState().session).toEqual(session);
    expect(svc.getState().error).toBeNull();
  });

  it('init() surfaces errors via state.error', async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: null }, error: { message: 'cannot reach supabase' } });

    await svc.init();

    expect(svc.getState().loading).toBe(false);
    expect(svc.getState().error).toBe('cannot reach supabase');
    expect(svc.getState().session).toBeNull();
  });

  it('markFatal sets error and clears loading', () => {
    svc.markFatal('something blew up');
    expect(svc.getState().error).toBe('something blew up');
    expect(svc.getState().loading).toBe(false);
  });

  it('subscribe receives current state immediately and on changes', async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: null }, error: null });

    const calls: Array<{ loading: boolean; session: unknown }> = [];
    const unsubscribe = svc.subscribe((s) => calls.push({ loading: s.loading, session: s.session }));

    expect(calls).toHaveLength(1);
    expect(calls[0].loading).toBe(true);

    await svc.init();
    expect(calls.at(-1)?.loading).toBe(false);

    unsubscribe();
    svc.markFatal('after-unsub');
    expect(calls.at(-1)?.loading).toBe(false); // unchanged after unsubscribe
  });

  it('signIn delegates to supabase', async () => {
    mockSignIn.mockResolvedValueOnce({ error: null });
    await svc.signIn('a@b', 'pw');
    expect(mockSignIn).toHaveBeenCalledWith({ email: 'a@b', password: 'pw' });
  });

  it('signIn throws supabase errors', async () => {
    mockSignIn.mockResolvedValueOnce({ error: new Error('bad creds') });
    await expect(svc.signIn('a@b', 'pw')).rejects.toThrow('bad creds');
  });

  it('signUp delegates to supabase', async () => {
    mockSignUp.mockResolvedValueOnce({ error: null });
    await svc.signUp('a@b', 'pw');
    expect(mockSignUp).toHaveBeenCalledWith({ email: 'a@b', password: 'pw' });
  });

  it('getToken returns access_token from session', async () => {
    mockGetSession.mockResolvedValueOnce({
      data: { session: { access_token: 'jwt-abc', user: { id: 'u' } } },
      error: null,
    });
    await svc.init();
    expect(await svc.getToken()).toBe('jwt-abc');
  });

  it('getToken returns null when no session', async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    await svc.init();
    expect(await svc.getToken()).toBeNull();
  });
});
