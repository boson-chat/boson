// AccountService — the package-agnostic interface for everything a
// caller wants to do with a NickServ account. Hides the differences
// between Atheme, Anope, and Ergo (verb names, multi-step flows,
// reply phrasings) behind a single result-typed API.
//
// Layering:
//
//   UI / panel / chat.service.ts          ← only this layer
//        ▲
//        │  await accountService.drop(pw) → DropResult
//        ▼
//   AccountService (this file — interface only)
//        ▲
//        │  one impl per services package
//        ▼
//   AnopeAccountService / AthemeAccountService / ErgoAccountService
//        ▲
//        │  PRIVMSG NickServ + onEvent
//        ▼
//   ServerSession (engine.client.ts)
//
// Operations resolve to a discrete result kind — `{ kind: 'dropped' }`
// vs `{ kind: 'wrong-password' }` etc — so the caller can switch on
// the kind without parsing strings or knowing about per-package
// quirks. Multi-step server dances (Atheme's KEY replay, Anope's
// DROP CONFIRM follow-up, the 2-arg fallback for production-Anope
// builds) all live INSIDE the impl, not in the caller.

import type { AccountStatus } from './services-credentials';

// ---------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------

// REGISTER outcomes.
//   pending-confirmation: server expects a CONFIRM/VERIFY step + emailed code.
//   registered:           no-confirm flow — account is live, may need IDENTIFY.
//   nick-taken:           the nick is already registered by someone else.
//   email-rejected:       server refused the email address (blacklisted,
//                         malformed, or one-per-account policy hit).
//   failed:               anything else; surface `reason` verbatim to the user.
export type RegisterResult =
  | { kind: 'pending-confirmation'; email: string }
  | { kind: 'registered' }
  | { kind: 'nick-taken' }
  | { kind: 'email-rejected'; reason: string }
  | { kind: 'failed'; reason: string };

// IDENTIFY outcomes.
//   identified:             password matched, account confirmed, fully auth'd.
//   identified-unconfirmed: password matched BUT the account is still pending
//                           email confirmation (Anope allows this — Atheme can
//                           too depending on `auth` config). Caller should keep
//                           the confirm-code prompt visible.
//   wrong-password:         password didn't match an existing account.
//   no-such-account:        the nick isn't registered (or just got dropped).
//   failed:                 fallback; surface `reason`.
export type IdentifyResult =
  | { kind: 'identified' }
  | { kind: 'identified-unconfirmed' }
  | { kind: 'wrong-password' }
  | { kind: 'no-such-account' }
  | { kind: 'failed'; reason: string };

// CONFIRM outcomes (post-REGISTER email/code verification).
//   confirmed:   code accepted, account is now fully registered.
//   wrong-code:  code didn't match. User can retry.
//   expired:     code expired (some servers TTL the codes; user must REGISTER again).
//   failed:      fallback.
export type ConfirmResult =
  | { kind: 'confirmed' }
  | { kind: 'wrong-code' }
  | { kind: 'expired' }
  | { kind: 'failed'; reason: string };

// DROP outcomes.
//   dropped:           account is gone server-side.
//   wrong-password:    DROP needed a password and we got the wrong one.
//                      (Atheme rejects 2-arg DROP with wrong pw before the
//                      key step; Anope-with-pw-patch rejects similarly.)
//   no-such-account:   the nick isn't registered, nothing to drop.
//   failed:            fallback. For Atheme this includes the "Invalid key
//                      for DROP" case (server-issued key didn't match what
//                      we re-fired — usually a bug in our extraction, not
//                      something the user can fix).
export type DropResult =
  | { kind: 'dropped' }
  | { kind: 'wrong-password' }
  | { kind: 'no-such-account' }
  | { kind: 'failed'; reason: string };

// RESEND outcomes — Anope-only. Other packages: `supportsResend()`
// returns false, and the UI hides the button entirely.
//   sent:        server (re-)dispatched the confirmation email.
//   cooldown:    rate-limit hit; `retryAfterMs` is our best estimate
//                of the remaining wait (Anope's `resenddelay` default
//                is 300s, server reply doesn't carry precise remaining).
//   failed:      fallback.
export type ResendResult =
  | { kind: 'sent' }
  | { kind: 'cooldown'; retryAfterMs: number }
  | { kind: 'failed'; reason: string };

// Parsed `INFO <account>` reply. Each services package emits a
// multi-line block; we normalise to this shape. Fields are optional
// because not every package surfaces every datum (e.g. Ergo doesn't
// emit a "last seen" line in default builds).
export interface AccountInfo {
  // The account name as the server has it (case + capitalisation
  // sometimes drift from the looked-up nick).
  accountName: string;
  // True if email confirmation has been completed. Undefined if the
  // package's reply didn't make the state visible (we won't assume).
  confirmed?: boolean;
  // The email address the account was registered with, if visible.
  // Atheme HIDES this by default for non-self lookups; expect undefined.
  email?: string;
  // Server-reported registration time, if visible (epoch ms).
  registeredAt?: number;
  // Server-reported last login time, if visible (epoch ms).
  lastSeenAt?: number;
  // Raw INFO body, preserved verbatim so the panel can render the
  // canonical server output as a fallback. Lines joined with '\n'.
  rawBody: string;
}

// Returned by methods that aren't supported on this package
// (e.g. resend() on Atheme/Ergo). Callers should not normally see
// this — `supportsX()` is the right gate — but defensive typing.
export type UnsupportedResult = { kind: 'unsupported'; verb: string };

// ---------------------------------------------------------------------
// The interface itself
// ---------------------------------------------------------------------

export interface AccountService {
  // Identifies which services package this impl talks to. The UI
  // sometimes wants this for display ("Detected: Atheme") but should
  // never branch on it for behaviour — that's what this interface is
  // for.
  readonly framework: 'atheme' | 'anope' | 'ergo';

  // ---- Operations -----------------------------------------------------
  //
  // Each runs the full multi-step dance internally and resolves to a
  // discrete result. The caller doesn't see intermediate prompts.
  //
  // All ops have a built-in timeout (default 10s, overridable per impl
  // via a constructor option) — if the server never sends a terminal
  // reply, the op resolves to `{ kind: 'failed', reason: 'timeout' }`
  // rather than hanging the UI forever.

  register(password: string, email: string): Promise<RegisterResult>;

  identify(password: string): Promise<IdentifyResult>;

  // The account name is passed explicitly because some packages
  // (Atheme, Ergo) require it inline in the verify command, and the
  // account name might differ from the current nick (the user could
  // have nick-changed before confirming).
  confirm(accountName: string, code: string): Promise<ConfirmResult>;

  // password is required because Atheme and patched-Anope ns_drop
  // both want it on the wire. On packages that don't need it (vanilla
  // Anope 2.0, Ergo), the impl ignores the argument. The single
  // signature avoids per-caller branching.
  drop(accountName: string, password: string): Promise<DropResult>;

  info(accountName: string): Promise<AccountInfo>;

  // ---- Capabilities + optional ops ------------------------------------
  //
  // Resend exists only on Anope. Callers should always check
  // `supportsResend()` first — calling `resend()` on a package that
  // doesn't support it returns `{ kind: 'unsupported', verb: 'resend' }`
  // immediately without any wire traffic, so it's safe but pointless.

  supportsResend(): boolean;
  resend(accountName: string): Promise<ResendResult | UnsupportedResult>;

  // ---- Observable badge status ----------------------------------------
  //
  // Independent of the operations above — this is the persisted status
  // visible in the UI badge. Reflects the most recently classified
  // NickServ NOTICE state, including UNSOLICITED ones (e.g. the user
  // identified via SASL elsewhere and we observe the success notice).
  //
  // Subscribers receive the current status on attach (synchronous
  // replay) so the panel doesn't have to special-case mount time.

  status(): AccountStatus | undefined;
  onStatusChange(fn: (s: AccountStatus | undefined) => void): () => void;

  // Release any subscriptions / timeouts. Called when the
  // ServerSession this AccountService was bound to disconnects.
  dispose(): void;
}

// Factory + selector. UI never instantiates impls directly — it asks
// for the AccountService bound to a given session/framework. When the
// framework is unknown the factory returns AnopeAccountService — same
// fallback policy adapters.ts uses today (Anope is the most common
// UnrealIRCd-network shape).
//
// The actual factory function lives in account-service-factory.ts
// (to be added in Step 2 when the first impl arrives). This file
// stays interface-only so it can be imported without pulling impl
// code into the bundle until something needs it.
