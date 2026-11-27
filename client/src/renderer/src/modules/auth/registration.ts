// What a network's sign-up looks like to its sign-in screens, from its
// GET /v1/config: open, invite-only (the invite code is asked for first,
// and required) or closed (no sign-up at all: existing accounts sign in,
// others use an account from another Boson server or come in as guests).
import type { AuthConfig } from './auth.service';

export type SignupMode = 'open' | 'invite' | 'closed';

export function signupMode(cfg: Pick<AuthConfig, 'registration' | 'accounts'> | null | undefined): SignupMode {
  if (cfg?.registration === 'closed') return 'closed';
  // The account backend can't sign people up (a NickServ backend without
  // registration), or a newer auth service says so for closed registration.
  if (cfg?.accounts?.signup === false) return 'closed';
  return cfg?.registration === 'invite' ? 'invite' : 'open';
}

// The line a sign-in screen shows when a network takes no new accounts,
// saying what's left: an account from elsewhere (federation, e.g. "your
// boson.chat account"), guest access, or just signing in.
export function closedSignupLine(opts: {
  // The network's display name.
  name: string;
  // How to name the account from elsewhere ("your boson.chat account");
  // null when the network doesn't take accounts from other servers.
  federated: string | null;
  guests: boolean;
}): string {
  const { name, federated, guests } = opts;
  const head = `${name} isn't taking new accounts.`;
  if (federated && guests) return `${head} Use ${federated}, or continue as a guest.`;
  if (federated) return `${head} Use ${federated}, or sign in if you have an account here.`;
  if (guests) return `${head} Sign in if you have an account, or continue as a guest.`;
  return `${head} Sign in if you have an account.`;
}
