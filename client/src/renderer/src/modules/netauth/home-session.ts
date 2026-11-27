// A self-hosted web client's own network, signed in to while the app is in
// guest mode (the network sign-in dialog's "Continue as alice@boson.chat",
// or its own account), holds the app's account: signed in there is signed
// in, not a guest. The session moves to the app's main auth service
// (NetworkAccounts.adoptHomeSession), guest mode ends, and the login screen
// goes straight to the identity key (its passphrase, or the keychain).
//
// The sign-in screen's own "Continue as …" signs the main account in
// directly (LoginBloc.continueFederated); this covers sessions made beside
// guest mode, including ones saved by earlier versions.
import { clearGuestSession, emitGuestChange, loadGuestSession } from '../guest/guest';
import { resumeIdentityOnLogin } from '../auth/resume-identity';
import type { NetworkAccounts } from './network-accounts';

export async function promoteHomeSession(accounts: Pick<NetworkAccounts, 'adoptHomeSession'>): Promise<boolean> {
  if (!loadGuestSession()) return false;
  let moved = false;
  try {
    moved = await accounts.adoptHomeSession();
  } catch (err) {
    console.warn('[netauth] could not make the home network session the app\'s own', err);
    return false;
  }
  if (!moved) return false;
  resumeIdentityOnLogin();
  clearGuestSession();
  emitGuestChange();
  return true;
}

// Promotes once `ready` (both auth services restored), then whenever the
// network accounts change (a sign-in in the dialog). Returns a stop.
export function keepHomeSessionSignedIn(accounts: NetworkAccounts, ready: Promise<unknown>): () => void {
  let stopped = false;
  let running = false;
  let again = false;
  const run = (): void => {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    void promoteHomeSession(accounts).finally(() => {
      running = false;
      if (again) { again = false; run(); }
    });
  };
  let off = (): void => {};
  void ready.then(() => {
    if (stopped) return;
    run();
    off = accounts.subscribe(run);
  }, () => {});
  return () => { stopped = true; off(); };
}
