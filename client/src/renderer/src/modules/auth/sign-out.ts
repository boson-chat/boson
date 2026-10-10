import type { ChatHistoryStore } from '../history';
import type { IdentityService } from '../identity';
import type { SessionStore } from '../session';
import type { AuthService } from './auth.service';

export interface SignOutDeps {
  auth: Pick<AuthService, 'getState' | 'signOut'>;
  identity: Pick<IdentityService, 'clearStorage' | 'lock'>;
  sessionStore: Pick<SessionStore, 'clear'>;
  history?: Pick<ChatHistoryStore, 'wipeAllForUser'> | null;
}

// Full account sign-out for this device: forget the saved session, the
// keychain copy of the identity secret and the user's scrollback, lock the
// in-memory identity, then end the Supabase session. Order matters: the
// keychain + history are keyed by the user id, which is gone once
// auth.signOut() has run. Mirrors DirectoryBloc.signOut (the directory's
// own button) for sign-outs started elsewhere, e.g. User settings.
export async function signOutAndForget({ auth, identity, sessionStore, history }: SignOutDeps): Promise<void> {
  sessionStore.clear();
  const userId = auth.getState().session?.user?.id;
  if (userId) {
    await identity.clearStorage(userId);
    if (history) {
      try {
        await history.wipeAllForUser(userId);
      } catch {
        // Best-effort — proceed with sign-out even if storage hiccups.
      }
    }
  }
  identity.lock();
  await auth.signOut();
}
