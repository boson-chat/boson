// How the app logs in to a network's IRC server with that network's account:
// SASL OAUTHBEARER with a fresh access token of the network's own auth
// service (every connect and reconnect asks for one; AuthService refreshes
// it first when it's about to expire). Networks without accounts, guests and
// bouncer routes connect as before.

import { sanitizeIrcNick } from '../identity/nick';
import type { IrcEvent } from '../engine';
import type { NetworkAccounts, NetworkLink } from './network-accounts';

export interface IrcLogin {
  link: NetworkLink | null;
  // The access token for SASL OAUTHBEARER (absent: no account login).
  token?: string;
  // The nick to use: the network account's username (absent: the usual).
  nick?: string;
}

export interface IrcLoginOptions {
  // A connect the user started (not a restore or a background reconnect):
  // may show the network's sign-in dialog.
  interactive: boolean;
  serverName: string;
  // Connect as a guest this time even if signed in (after the user chose
  // that when the IRC server refused the token).
  guest?: boolean;
}

// Works out the IRC login for host's network. 'cancel': the user closed the
// sign-in dialog without picking a way in — don't connect.
export async function resolveIrcLogin(
  accounts: NetworkAccounts | null,
  host: string,
  opts: IrcLoginOptions,
): Promise<IrcLogin | 'cancel'> {
  if (!accounts) return { link: null };
  const link = await accounts.discover(host).catch(() => null);
  if (!link) return { link: null };
  if (opts.guest) return { link };
  let session = accounts.sessionFor(link);
  if (!session) {
    const guestOk = await accounts.guestAllowed(link);
    // The app's own networks don't ask app-wide guests again (they chose
    // that at launch) unless the network takes no guests.
    const ask = opts.interactive && (link.main ? !guestOk : (!guestOk || !accounts.guestChosen(host)));
    if (!ask) return { link };
    const outcome = await accounts.promptSignIn({
      link,
      serverName: opts.serverName,
      reason: guestOk ? 'connect' : 'required',
      allowGuest: guestOk,
    });
    if (outcome === 'cancel') return 'cancel';
    if (outcome === 'guest') return { link };
    session = accounts.sessionFor(link);
    if (!session) return { link };
  }
  const token = await accounts.ircToken(link).catch(() => null);
  if (!token) return { link };
  // A federated account's nick defaults to the handle the network gave it
  // (alice, or alice-bosonchat when alice was taken).
  const nick = link.main ? undefined : sanitizeIrcNick(session.federated?.handle || session.user.username) || undefined;
  return { link, token, ...(nick ? { nick } : {}) };
}

// The IRC server's "no guests here" (Ergo accounts.require-sasl: FAIL *
// ACCOUNT_REQUIRED, then ERROR) — or the reason text it closed with.
export function isAccountRequired(e: Pick<IrcEvent, 'Kind' | 'Args' | 'Message'>): boolean {
  if (e.Kind === 'FAIL') return (e.Args ?? []).includes('ACCOUNT_REQUIRED') || /\bSASL\b/i.test(e.Message ?? '');
  return false;
}

export function isAccountRequiredText(text: string | null | undefined): boolean {
  return !!text && /(ACCOUNT_REQUIRED|log in with SASL|must (log in|authenticate|be logged in)|requires? (an )?account)/i.test(text);
}

// 904 ERR_SASLFAIL: the server refused our SASL login.
export function isSaslFailure(e: Pick<IrcEvent, 'Kind'>): boolean {
  return e.Kind === '904' || e.Kind === '902';
}
