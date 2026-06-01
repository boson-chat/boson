// Shared helpers used by every AccountService impl. Centralised so a
// fix in one place (e.g. supporting a new "you must reply with"
// variant a future services package introduces) lands in every
// impl at once instead of needing per-package syncs.

// IRC formatting bytes — bold (\x02), reset (\x0f), monospace (\x11),
// reverse (\x16), italic (\x1d), strikethrough (\x1e), underline (\x1f).
// NickServ replies on Atheme and Anope wrap things like account names
// in \x02...\x02 (bold); strip before regex matching so the anchors
// don't need to consider them.
export function stripFormat(s: string): string {
  return s.replace(/[\x02\x0f\x11\x16\x1d\x1e\x1f]/g, '');
}

// Phrases that introduce an inline `/msg NickServ <verb> <args>`
// the server wants us to echo back. Four anchored forms — each one
// observed live on at least one services package:
//
//   "please confirm by replying [with]"  → Atheme docker DROP, Anope 3-arg variant
//   "to confirm, type"                    → Anope canonical DROP CONFIRM
//   "to confirm: run this command"        → Ergo variants
//   "you must reply with"                 → Atheme/Libera drop.c, verify.c
//   "you must respond with"               → Atheme variant
//   "to complete <X> ... reply with"      → Atheme drop.c key replay
//
// Deliberately strict — earlier iterations had a bare `reply with`
// alternation that false-matched help notices ("If you need help,
// reply with /msg NickServ HELP …"), causing replay loops.
//
// Followed somewhere in the same body by `/msg NickServ` or `/NS`
// (the long form and the Ergo-style shorthand both work).
export const REPLAY_PHRASES =
  /\b(?:please\s+confirm\s+by\s+replying|to\s+confirm[,:]?\s+(?:type[d,:]?|run\s+this\s+command)|you\s+must\s+(?:reply|respond)\s+with|to\s+complete\b[^/]*\breply\s+with)\b[^/]*\/(?:msg\s+nickserv|ns)\s+/i;

// Extract the verb+args portion after `/msg NickServ` (or `/NS`) from
// a body that matched REPLAY_PHRASES. Trims trailing punctuation /
// whitespace. Returns null if no inline command was found — the impl
// should treat that as a parse failure (we recognised the prompt but
// couldn't extract the follow-up).
//
// Pre-strip formatting bytes via `stripFormat` before calling this.
export function extractInlineNickservCommand(body: string): string | null {
  const m = body.match(/\/(?:msg\s+nickserv|ns)\s+(.+?)(?:[.\s]*$|[.]\s)/i);
  if (!m) return null;
  const cmd = m[1]!.trim();
  return cmd || null;
}

// ---- OperationGuard: in-flight dedupe ---------------------------
//
// Each AccountService impl is a singleton bound to a (server, nick)
// pair. The operations it exposes — drop, identify, register,
// confirm, resend — can't sensibly run concurrently with another
// invocation of THE SAME KIND on the same service. The wire is
// sequential, the server's session state is single-threaded, and on
// Atheme specifically the server issues a single second-step KEY
// per drop session — a duplicate replay sends a stale key and the
// server replies "Invalid key for DROP." (reproduced live: a user
// double-clicked "Yes, drop it" and saw `failed: invalid-key`).
//
// OperationGuard.dedupe('drop', factory) ensures that concurrent
// calls with the same key share a single underlying Promise. The
// second caller gets the first call's result — no second wire round
// trip, no race.
//
// Different operation keys still run in parallel (a drop alongside
// a register, hypothetically), so this doesn't serialise everything.
export class OperationGuard {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  dedupe<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = factory();
    this.inFlight.set(key, promise);
    // Clear the slot on both resolution and rejection. `.then(c, c)`
    // (not `.finally`) so the cleanup chain doesn't re-propagate a
    // rejection — that would surface as an unhandled-rejection even
    // when the original promise was awaited and handled by the
    // caller. The check `get(key) === promise` guards against a
    // fast follow-up call having already replaced this slot.
    const cleanup = (): void => {
      if (this.inFlight.get(key) === promise) {
        this.inFlight.delete(key);
      }
    };
    promise.then(cleanup, cleanup);
    return promise;
  }
}

// ---- IDENTIFY operation runner ----------------------------------
//
// Shared because all three packages accept `IDENTIFY <password>`
// with the same shape and reply set. Each impl just calls this and
// returns the result.
//
// Uses session.nickservIdentify() — the dedicated engine command,
// not raw PRIVMSG — so the password takes the same code path the
// connect-time auto-identify uses (engine owns the wire-level
// formatting + the message-tagged "credential" marker).
import type { ServerSession } from '../engine/engine.client';
import type { IrcEvent } from '../engine/engine.types';
import type { IdentifyResult } from './account-service';
import { isNickServSender } from './services';

const IDENTIFY_TIMEOUT_DEFAULT_MS = 10_000;

export function runIdentify(
  session: ServerSession,
  myNick: string,
  password: string,
  timeoutMs: number = IDENTIFY_TIMEOUT_DEFAULT_MS,
): Promise<IdentifyResult> {
  return new Promise<IdentifyResult>((resolve) => {
    let resolved = false;
    let unsubscribe: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: IdentifyResult): void => {
      if (resolved) return;
      resolved = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    timer = setTimeout(
      () => finish({ kind: 'failed', reason: 'timeout' }),
      timeoutMs,
    );

    unsubscribe = session.onEvent((e: IrcEvent) => {
      if (e.Kind !== 'NOTICE') return;
      if (!isNickServSender(e.From)) return;
      if (e.Target !== myNick) return;
      const result = classifyIdentifyReply(e.Message);
      if (result) finish(result);
    });

    // Use the dedicated engine path so the password follows the same
    // route as connect-time auto-identify (and stays out of the raw
    // PRIVMSG log).
    session.nickservIdentify(password);
  });
}

// ---- RESEND operation runner (Anope-only) ----------------------
//
// `RESEND` re-sends the activation email for a pending account.
// Anope-only — Atheme has no equivalent (`nickserv/register.c`
// explicitly tells the user to DROP + re-REGISTER if the email
// didn't arrive). Atheme/Ergo impls return `{ kind: 'unsupported' }`
// directly without touching the wire; this runner only fires for
// the Anope path.
//
// Anope's `resenddelay` config (default 300s) limits how often a
// user can RESEND; the cooldown reply doesn't carry a precise
// remaining time so we conservatively pin retryAfterMs to the
// default 5-minute window.
import type { ResendResult } from './account-service';

const RESEND_DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

export function runResend(
  session: ServerSession,
  myNick: string,
  timeoutMs: number = IDENTIFY_TIMEOUT_DEFAULT_MS,
): Promise<ResendResult> {
  return new Promise<ResendResult>((resolve) => {
    let resolved = false;
    let unsubscribe: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: ResendResult): void => {
      if (resolved) return;
      resolved = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    timer = setTimeout(
      () => finish({ kind: 'failed', reason: 'timeout' }),
      timeoutMs,
    );

    unsubscribe = session.onEvent((e: IrcEvent) => {
      if (e.Kind !== 'NOTICE') return;
      if (!isNickServSender(e.From)) return;
      if (e.Target !== myNick) return;
      const result = classifyResendReply(e.Message);
      if (result) finish(result);
    });

    // Bare RESEND — the optional <nickname> argument is oper-only on
    // most Anope builds; regular users issue the bare form and the
    // server infers the account from the source.
    session.privmsg('NickServ', 'RESEND');
  });
}

// Classify a NickServ NOTICE body as a RESEND outcome. Returns null
// when the body isn't terminal.
//
//   Anope success (ns_register.cpp:412):
//     "The confirmation code for <nick> has been re-sent to <email>."
//     Tolerates the unhyphenated "resent" variant some builds emit.
//   Anope cooldown (ns_register.cpp:400):
//     "Cannot send mail now; please retry a little later."
//   Generic failures: "Email could not be sent" / "Mail not configured".
export function classifyResendReply(body: string): ResendResult | null {
  const s = stripFormat(body);

  if (/\b(?:has been re-?sent to)\b/i.test(s)) return { kind: 'sent' };
  if (/\bemail (?:has been )?re-?sent\b/i.test(s)) return { kind: 'sent' };

  if (/\bcannot send mail (?:now|yet)\b/i.test(s)) return { kind: 'cooldown', retryAfterMs: RESEND_DEFAULT_COOLDOWN_MS };
  if (/\bretry a little later\b/i.test(s)) return { kind: 'cooldown', retryAfterMs: RESEND_DEFAULT_COOLDOWN_MS };
  if (/\bplease wait\b[\s\S]*?\bbefore\b[\s\S]*?\b(?:resend|sending|requesting)\b/i.test(s)) {
    return { kind: 'cooldown', retryAfterMs: RESEND_DEFAULT_COOLDOWN_MS };
  }

  if (/\bemail (?:could not be|cannot be) sent\b/i.test(s)) return { kind: 'failed', reason: s.trim() };
  if (/\bmail (?:is )?not (?:configured|enabled)\b/i.test(s)) return { kind: 'failed', reason: s.trim() };

  return null;
}

// ---- CONFIRM operation runner ----------------------------------
//
// The CONFIRM verb DIFFERS per package — Anope uses `CONFIRM <code>`
// (no account name; server knows from session), Atheme uses
// `VERIFY REGISTER <acct> <code>` (literal `REGISTER` operation
// keyword), Ergo uses `VERIFY <acct> <code>`. So the caller passes
// the fully-formed command string and the runner just awaits a
// terminal reply.
import type { ConfirmResult } from './account-service';

export function runConfirm(
  session: ServerSession,
  myNick: string,
  command: string,
  timeoutMs: number = IDENTIFY_TIMEOUT_DEFAULT_MS,
): Promise<ConfirmResult> {
  return new Promise<ConfirmResult>((resolve) => {
    let resolved = false;
    let unsubscribe: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: ConfirmResult): void => {
      if (resolved) return;
      resolved = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    timer = setTimeout(
      () => finish({ kind: 'failed', reason: 'timeout' }),
      timeoutMs,
    );

    unsubscribe = session.onEvent((e: IrcEvent) => {
      if (e.Kind !== 'NOTICE') return;
      if (!isNickServSender(e.From)) return;
      if (e.Target !== myNick) return;
      const result = classifyConfirmReply(e.Message);
      if (result) finish(result);
    });

    session.privmsg('NickServ', command);
  });
}

// Classify a NickServ NOTICE body as a CONFIRM/VERIFY outcome.
// Returns null when the body isn't terminal so the impl keeps waiting.
//
// Patterns ordered by specificity:
//   1. Confirmed (most-specific phrasings first).
//   2. Wrong-code (must check BEFORE expired because some servers
//      use phrasings like "Invalid code; this account is no longer
//      pending verification" — we want wrong-code, not expired).
//   3. Expired / not-pending.
export function classifyConfirmReply(body: string): ConfirmResult | null {
  const s = stripFormat(body);

  // ---- confirmed ------------------------------------------------
  //
  //   Anope    "Your email address of <X> has been confirmed."
  //            "Your account is now confirmed."
  //   Atheme   (verify.c:12,13) "Thank you for verifying your e-mail address!"
  //            "<account> has now been verified."
  //   Ergo     "Account successfully registered" /
  //            "Account successfully verified"
  // `[\s\S]*?` not `[^.]*` because the slot can contain an email
  // address like "alice@example.com" — a literal `[^.]` excludes
  // the period and breaks the match.
  if (/\bemail address\b[\s\S]*?\bhas been confirmed\b/i.test(s)) return { kind: 'confirmed' };
  if (/\baccount is now confirmed\b/i.test(s)) return { kind: 'confirmed' };
  if (/\bemail verification complete\b/i.test(s)) return { kind: 'confirmed' };
  if (/\bhas now been verified\b/i.test(s)) return { kind: 'confirmed' };
  if (/\bthank you for verifying\b/i.test(s)) return { kind: 'confirmed' };
  if (/\baccount successfully (?:verified|registered)\b/i.test(s)) return { kind: 'confirmed' };

  // ---- wrong-code -----------------------------------------------
  //
  //   Anope    "Invalid passcode."
  //   Atheme   "Verification failed. Invalid key for VERIFY."
  //   Ergo     "Account verification failed: code mismatch" /
  //            "Invalid verification code"
  if (/\binvalid (?:passcode|verification|code|key)\b/i.test(s)) return { kind: 'wrong-code' };
  if (/\bincorrect (?:passcode|verification|code)\b/i.test(s)) return { kind: 'wrong-code' };
  if (/\bverification failed\b/i.test(s)) return { kind: 'wrong-code' };
  if (/\bcode mismatch\b/i.test(s)) return { kind: 'wrong-code' };

  // ---- expired / not-pending ------------------------------------
  //
  //   Atheme    (verify.c:74,103) "<name> is not awaiting verification."
  //             (Could mean: already verified OR code expired.
  //              Treated as expired so the user knows to retry —
  //              either by re-running INFO to see current state
  //              or by registering fresh.)
  //   Common    "verification code has expired" / "no longer valid"
  if (/\bcode\b[^.]*\bexpired\b/i.test(s)) return { kind: 'expired' };
  if (/\bis not awaiting verification\b/i.test(s)) return { kind: 'expired' };
  if (/\bno longer (?:valid|pending)\b/i.test(s)) return { kind: 'expired' };

  return null;
}

// ---- REGISTER operation runner ----------------------------------
//
// All three packages accept `REGISTER <password> <email>` with the
// same shape. Replies bifurcate by whether email confirmation is
// required (server-config-dependent), so the runner waits for the
// first terminal classifier hit and surfaces either:
//
//   pending-confirmation  — email confirm required; user gets a code
//                           in their inbox + must call confirm() next.
//   registered            — no-confirm flow; the account is live and
//                           we can auto-identify immediately.
//   nick-taken            — someone already owns this nick.
//   email-rejected        — invalid / blacklisted / duplicate email.
//   failed                — generic; surface reason for the user.
//
// The email is passed back inside the pending-confirmation result so
// the caller doesn't have to track it separately for the eventual
// confirm() call. Sent via raw PRIVMSG (no dedicated engine command
// for register, unlike identify).
import type { RegisterResult } from './account-service';

export function runRegister(
  session: ServerSession,
  myNick: string,
  password: string,
  email: string,
  timeoutMs: number = IDENTIFY_TIMEOUT_DEFAULT_MS,
): Promise<RegisterResult> {
  return new Promise<RegisterResult>((resolve) => {
    let resolved = false;
    let unsubscribe: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: RegisterResult): void => {
      if (resolved) return;
      resolved = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    timer = setTimeout(
      () => finish({ kind: 'failed', reason: 'timeout' }),
      timeoutMs,
    );

    unsubscribe = session.onEvent((e: IrcEvent) => {
      if (e.Kind !== 'NOTICE') return;
      if (!isNickServSender(e.From)) return;
      if (e.Target !== myNick) return;
      const result = classifyRegisterReply(e.Message, email);
      if (result) finish(result);
    });

    session.privmsg('NickServ', `REGISTER ${password} ${email}`);
  });
}

// Classify a NickServ NOTICE body as a REGISTER outcome. Returns null
// when the body isn't terminal (warning notices, info banners, etc.
// that arrive between the REGISTER and the actual result).
//
// Pattern ordering is critical:
//
//   1. pending-confirmation patterns FIRST — Ergo's "Account created,
//      pending verification" otherwise gets eaten by the broader
//      "account created" registered match below.
//   2. registered patterns next.
//   3. specific failure phrasings (nick-taken, email-rejected) before
//      the generic failed catch (which we don't have — returns null
//      so the impl keeps waiting or times out).
export function classifyRegisterReply(body: string, email: string): RegisterResult | null {
  const s = stripFormat(body);

  // ---- pending-confirmation (must come first) --------------------
  //
  //   Anope    "Please type \"/msg NickServ CONFIRM <code>\" to confirm"
  //   Atheme   (register.c:192) "An email containing nickname activation
  //              instructions has been sent to <addr>."
  //   Ergo     (nickserv.go:1031) "Account created, pending verification;
  //              verification code has been sent to <addr>"
  //   General  "Please verify your email" / "Check your inbox for ..."
  if (/\/msg\s+nickserv\s+(?:confirm|verify\s+register)\b/i.test(s)) return { kind: 'pending-confirmation', email };
  if (/\baccount created\b[\s\S]*\bpending verification\b/i.test(s)) return { kind: 'pending-confirmation', email };
  if (/\bactivation instructions\b[\s\S]*\bsent\b/i.test(s)) return { kind: 'pending-confirmation', email };
  if (/\bverification code\b[\s\S]*\bsent\b/i.test(s)) return { kind: 'pending-confirmation', email };
  if (/\bemail verification\b[\s\S]*\bsent\b/i.test(s)) return { kind: 'pending-confirmation', email };
  if (/\bverify your email\b/i.test(s)) return { kind: 'pending-confirmation', email };
  if (/\bcheck your (?:e-?mail|inbox) for\b/i.test(s)) return { kind: 'pending-confirmation', email };

  // ---- registered (no-confirm flow) ------------------------------
  //
  //   Anope     "Nickname X has been registered."
  //   Atheme    (post-no-confirm) "<name> is now registered to <addr>."
  //   Ergo      "Account created" (when verification is disabled)
  //   Generic   "Successfully registered"
  if (/\bis now registered to\b/i.test(s)) return { kind: 'registered' };
  if (/\b(?:nickname|account)\b[^.]*\bhas been registered\b/i.test(s)) return { kind: 'registered' };
  if (/\bsuccessfully registered\b/i.test(s)) return { kind: 'registered' };
  if (/\baccount created\b/i.test(s)) return { kind: 'registered' };

  // ---- nick-taken ------------------------------------------------
  //
  //   "Nickname X is already registered."
  //   "Account X is already registered"
  //   "X is already registered" (Atheme variant on auth=none)
  if (/\bis already registered\b/i.test(s)) return { kind: 'nick-taken' };
  if (/\baccount\b[^.]*\balready registered\b/i.test(s)) return { kind: 'nick-taken' };

  // ---- email-rejected --------------------------------------------
  //
  // Phrasings vary widely — capture the most-cited ones. Surface
  // the raw body as `reason` so the user sees what the server
  // actually said.
  if (/\binvalid (?:e-?mail|address)\b/i.test(s)) return { kind: 'email-rejected', reason: s.trim() };
  if (/\bemail (?:address )?(?:is )?blacklisted\b/i.test(s)) return { kind: 'email-rejected', reason: s.trim() };
  if (/\bemail (?:address )?(?:is )?already (?:in use|registered)\b/i.test(s)) return { kind: 'email-rejected', reason: s.trim() };
  if (/\bemail .* not allowed\b/i.test(s)) return { kind: 'email-rejected', reason: s.trim() };

  return null;
}

// ---- IDENTIFY reply classification -------------------------------
//
// All three services packages share the same IDENTIFY command shape
// (`IDENTIFY <password>`) and overlap heavily on reply phrasings, so
// classification is centralised here. Returns null when the body
// isn't a terminal IDENTIFY outcome (impls should keep waiting).
//
// Order matters: more-specific phrasings (auth failed + account-does-
// not-exist combined) must match before the broader fallbacks.
export function classifyIdentifyReply(body: string): IdentifyResult | null {
  const stripped = stripFormat(body);

  // ---- Success ----------------------------------------------------
  //
  //   Atheme  (modules/nickserv/identify.c:159)
  //     "You are now identified for <name>." /
  //     "You are now logged in as <name>." /
  //     "You are already logged in as <name>."
  //   Anope   "Password accepted - you are now recognized." /
  //           "You are already identified."
  //   Ergo    (irc/handlers.go) "You're now logged in as <account>." /
  //           "You're already logged into an account."
  if (/\byou are (?:now|already) identified\b/i.test(stripped)) return { kind: 'identified' };
  if (/\bpassword accepted\b/i.test(stripped)) return { kind: 'identified' };
  if (/\byou are now recognized\b/i.test(stripped)) return { kind: 'identified' };
  if (/\byou(?:'re| are) (?:now|already) logged in as\b/i.test(stripped)) return { kind: 'identified' };
  if (/\byou(?:'re| are) already logged into an account\b/i.test(stripped)) return { kind: 'identified' };

  // ---- Failures ---------------------------------------------------
  //
  // No-such-account checks run BEFORE generic password-wrong checks
  // because Ergo phrases its account-not-found as
  // "Authentication failed: Account does not exist" — the generic
  // "authentication failed" alternation would otherwise classify it
  // as wrong-password.
  //
  //   Atheme  (identify.c:63) "<name> is not a registered nickname."
  //   Anope   "Nick <name> isn't registered." (NICK_X_NOT_REGISTERED)
  //   Ergo    (errors.go) "Authentication failed: Account does not exist"
  //   Catch-all: "no such nick" / "no such account"
  if (/\baccount does not exist\b/i.test(stripped)) return { kind: 'no-such-account' };
  if (/\bis not (?:a )?registered nickname\b/i.test(stripped)) return { kind: 'no-such-account' };
  if (/\bisn'?t registered\b/i.test(stripped)) return { kind: 'no-such-account' };
  if (/\bno such (?:nick|account)\b/i.test(stripped)) return { kind: 'no-such-account' };

  //   Atheme  (identify.c:168) "Invalid password for <name>."
  //   Anope   "Password incorrect."
  //   Ergo    (errors.go) "Authentication failed: Invalid account credentials"
  //                       "Authentication failed: Account has been suspended"
  if (/\binvalid password\b/i.test(stripped)) return { kind: 'wrong-password' };
  if (/\bpassword incorrect\b/i.test(stripped)) return { kind: 'wrong-password' };
  if (/\bauthentication failed\b/i.test(stripped)) return { kind: 'wrong-password' };

  return null;
}
