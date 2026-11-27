// The next login screen finds a session already signed in (a home network
// session that just became the app's own, NetworkAccounts.adoptHomeSession):
// it goes straight to the identity key (keychain, or its passphrase) instead
// of the sign-in form. Read (and reset) by the next LoginScreen.
let resumeNext = false;

export function resumeIdentityOnLogin(): void { resumeNext = true; }

export function takeResumeIdentity(): boolean {
  const r = resumeNext;
  resumeNext = false;
  return r;
}
