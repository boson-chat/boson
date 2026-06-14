// Detection of IRC "services" — pseudo-users provided by the network for
// account management, channel management, off-channel memos, etc.
// (NickServ, ChanServ, …). Their NOTICEs are operational chatter, not chat
// content, so the ChatService routes them to a single per-connection
// `~server` pseudo-channel instead of creating a DM-style virtual channel
// per service. They're still readable when the user wants — they're just
// out of the way of real conversations.

// Synthetic channel name used by the chat service to collect all service /
// server messages for a given connection. The `~` prefix is deliberately
// not a valid IRC channel sigil (those are `#` and `&`), so no real channel
// can collide with this name; the channelKey helper preserves case to keep
// the lookup unambiguous.
export const SERVICE_CHANNEL = '~server';

// Display label rendered in the channel sidebar.
export const SERVICE_CHANNEL_LABEL = 'Server';

// Well-known service nicknames. The list mirrors what Atheme + Anope expose
// across the major networks (Libera, OFTC, IRCnet, etc.). Matching is
// case-insensitive — many networks UPPERCASE their service nicks while users
// type them in mixed case.
const SERVICE_NICKS: ReadonlySet<string> = new Set([
  'nickserv',
  'chanserv',
  'operserv',
  'memoserv',
  'botserv',
  'hostserv',
  'saslserv',
  'authserv',
  'aliasserv',
  'groupserv',
  'rootserv',
  'gameserv',
  'statserv',
  'helpserv',
  'global',  // network-wide announcements
]);

// Does this message come from a server-side service / pseudo-user?
//
// Two cases qualify:
//   1. From is a known service nick (case-insensitive)
//   2. From is the server's own hostname (contains a dot but no user@host
//      shape) — typical of raw server NOTICEs ("*** Looking up your hostname")
export function isServiceSender(from: string): boolean {
  if (!from) return true; // anonymous notices are always server-side
  // ZNC (and other bouncers) expose control bots as `*`-prefixed nicks
  // (`*status`, `*controlpanel`, `*playback`, …). They're operational chrome,
  // not conversations — route them to the ~server sink, never a DM/inbox.
  // Real IRC nicks can't start with `*`, so this is unambiguous.
  if (from.startsWith('*')) return true;
  const lower = from.toLowerCase();
  if (SERVICE_NICKS.has(lower)) return true;
  // Heuristic: a sender like "hub.example.org" is a server. Real nicks
  // can't contain `.` (sanitised on connect, and IRC RFCs disallow it).
  if (from.includes('.')) return true;
  return false;
}

// Is this target one the server uses during pre-registration (target=`*`
// before the client has a nick assigned, or `AUTH` from some daemons)?
// These never represent a real conversation and should be routed to the
// service pseudo-channel.
export function isServerWildcardTarget(target: string): boolean {
  return target === '*' || target === 'AUTH';
}

// MemoServ specifically — used by the ChatService to pull MemoServ
// NOTICEs out of the per-server chat log and into the global Inbox.
// Case-insensitive match because networks normalise service casing
// differently (NickServ on Libera, NickServ on OFTC, NICKSERV on
// some older daemons).
export function isMemoServSender(from: string): boolean {
  return from.toLowerCase() === 'memoserv';
}

// NickServ specifically — same casing tolerance as isMemoServSender.
// ChatService routes NOTICEs from NickServ through `classifyNickServReply`
// to keep the account status field (in the credentials store) in sync
// with whatever the service most recently told us.
export function isNickServSender(from: string): boolean {
  return from.toLowerCase() === 'nickserv';
}

// A NAMED service pseudo-user (NickServ, ChanServ, MemoServ, Global, …) —
// i.e. isServiceSender minus the server-host heuristic. Used to decide what's
// eligible for the Inbox: messages from named services can be inbox-worthy,
// but raw server-host NOTICEs (connection banners, MOTD-ish chatter) are not —
// those stay in the ~server log.
export function isNamedServiceSender(from: string): boolean {
  return SERVICE_NICKS.has(from.toLowerCase());
}

// One of the small set of NickServ reply patterns we care about for
// the Services panel's status indicator. Returning a tagged enum
// (rather than the raw body) keeps the renderer decoupled from
// per-package phrasing — the panel only cares "did identify succeed?",
// not "what verb did Atheme use this week to say so?".
//
// Null = "this reply didn't match any pattern we surface as a status
// transition" — the message still flows through the normal chat
// routing to the ~server pseudo-channel.
export type NickServReplyKind =
  // IDENTIFY accepted — Atheme: "You are now identified for X",
  // Anope: "Password accepted - you are now recognized".
  | 'identified-success'
  // IDENTIFY rejected — wrong password / no account. Both packages
  // emit short error strings here; phrasing varies enough that we
  // match on a small set of common substrings.
  | 'identify-failed'
  // REGISTER acknowledged, waiting on email confirmation. Atheme
  // says "an email has been sent... please verify"; Anope says
  // "please type /msg NickServ CONFIRM <code>".
  | 'registration-pending'
  // CONFIRM / VERIFY REGISTER succeeded. Anope: "Your account is
  // now confirmed"; Atheme: "Email verification complete".
  | 'registration-confirmed'
  // Account is registered but email-confirmation hasn't been
  // completed. Surfaces in INFO replies + as a follow-up to a
  // successful IDENTIFY on Anope, and via Atheme's MU_WAITAUTH
  // "NOT COMPLETED registration verification" marker. Maps to the
  // 'identified-unconfirmed' status so the UI can keep showing the
  // confirm-code input while the user is logged in.
  | 'account-unconfirmed'
  // First-touch nudge when we joined under a registered nick without
  // identifying. Both packages emit "This nickname is registered..."
  // verbatim or near-verbatim.
  | 'nick-registered-prompt'
  // DROP succeeded — the account is gone. Atheme: "The account X has
  // been dropped"; Anope: "Nickname X has been dropped". After this
  // the ChatService also clears the saved password + email because
  // the credentials no longer refer to anything.
  | 'drop-success'
  // DROP rejected by the server. Atheme: "Invalid key for DROP."
  // (sent when the second-step token doesn't match). The account
  // is still registered; UI should surface "drop didn't complete —
  // please retry" and leave the saved creds in place.
  | 'drop-failed'
  // Anope-style second-step prompt: the first DROP responds with
  // "To confirm, type: /msg NickServ DROP CONFIRM". We surface this
  // so ChatService can auto-fire the follow-up — the user already
  // opted into the destructive action via the panel's confirm step,
  // so a server-side second confirmation is friction we can absorb.
  | 'drop-confirm-prompt'
  // Production-Anope variant: ns_drop is patched/configured to
  // require 2 args. Server replies to single-arg DROP with
  // "Syntax: DROP <account> <password>". ChatService catches this
  // and re-fires with `DROP <nick> <password>` using the saved
  // creds — works on the deployments that demand both args
  // (verified live against irc.boson.chat) while still defaulting
  // to the canonical 1-arg form for vanilla Anope 2.0.x.
  | 'drop-needs-password'
  // Generic "please confirm by replying with /msg NickServ <verb>
  // <args>" prompt. Atheme's two-step DROP and irc.boson.chat's
  // operator-patched Anope both phrase the second-step as a
  // literal `/msg NickServ ...` command the user is expected to
  // paste back. ChatService captures everything after `/msg
  // NickServ` from the reply body and replays it verbatim as a
  // fresh PRIVMSG — no template guessing, no per-deployment
  // branching. The user already opted into the destructive action
  // via the panel's local confirm; replaying the server's own
  // suggested command is the friction-free path.
  | 'service-confirm-replay'
  // RESEND succeeded — the server (re-)dispatched the activation
  // email. Anope: "The confirmation code for X has been re-sent to
  // <email>." Side-effect signal: UI can flash "email re-sent" but
  // the persisted status stays at 'pending-confirmation' until the
  // user actually enters the code.
  | 'resend-success'
  // RESEND rejected because the server-side cooldown hasn't
  // elapsed. Anope: "Cannot send mail now; please retry a little
  // later." UI disables the Resend button for ~5 minutes (Anope's
  // resenddelay default is in that range; the reply doesn't carry
  // a precise remaining-time value).
  | 'resend-cooldown';

// Case-insensitive substring matches. Order matters — earlier hits
// win. We want the most-specific patterns first so e.g. a body
// containing both "registered" and "identified" doesn't false-match
// the prompt classifier.
//
// Patterns drawn from the reference table in
// `.claude/skills/boson-irc-cmd/SKILL.md` plus live observations on
// Anope deployments (irc.boson.chat).
const NICKSERV_PATTERNS: ReadonlyArray<{ kind: NickServReplyKind; rx: RegExp }> = [
  // ---- identified-success ----------------------------------------------
  //   Atheme  (modules/nickserv/identify.c:159)
  //     "You are now identified for <name>." / "You are now logged in as <name>."
  //   Atheme already-identified (identify.c:68,75)
  //     "You are already logged in as <name>."
  //   Anope   (live irc.boson.chat + ns_identify.cpp)
  //     "Password accepted - you are now recognized."
  //     "You are already identified."
  //   Ergo    (irc/handlers.go:112, nickserv.go via SendSuccessfulRegResponse)
  //     "You're now logged in as <account>."
  //     "You're already logged into an account."
  { kind: 'identified-success', rx: /\byou are now identified\b/i },
  { kind: 'identified-success', rx: /\byou are already identified\b/i },
  { kind: 'identified-success', rx: /\bpassword accepted\b/i },
  { kind: 'identified-success', rx: /\byou are now recognized\b/i },
  // Atheme + Ergo both phrase identify-success as "logged in as".
  // The apostrophe variant covers Ergo's "You're now logged in as".
  { kind: 'identified-success', rx: /\byou(?:'re| are) (?:now|already) logged in as\b/i },
  { kind: 'identified-success', rx: /\byou(?:'re| are) already logged into an account\b/i },

  // ---- identify-failed -------------------------------------------------
  //   Atheme  (identify.c:168) "Invalid password for <name>."
  //   Atheme  (identify.c:63)  "<name> is not a registered nickname."
  //   Anope                    "Password incorrect."
  //   Ergo    (errors.go:23-30) "Authentication failed: Invalid account credentials"
  //                              "Authentication failed: Account does not exist"
  //                              "Authentication failed: Account has been suspended"
  { kind: 'identify-failed', rx: /\binvalid password\b/i },
  { kind: 'identify-failed', rx: /\bpassword incorrect\b/i },
  { kind: 'identify-failed', rx: /\bauthentication failed\b/i },
  { kind: 'identify-failed', rx: /\bno such (?:nick|account)\b/i },
  { kind: 'identify-failed', rx: /\bis not a registered nickname\b/i },
  // Anope's NICK_X_NOT_REGISTERED template ("Nick X isn't
  // registered.") — observed live on irc.boson.chat when IDENTIFY /
  // INFO / DROP is issued on a nick that doesn't exist (or was
  // just dropped). The reply format prints the looked-up nick + the
  // source mask in the %s slot.
  // Optional apostrophe in `isn't` so we tolerate locale variants
  // that normalize the contraction.
  { kind: 'identify-failed', rx: /\bisn'?t registered\b/i },

  // ---- account-unconfirmed --------------------------------------------
  //   Anope   (live + ns_info.cpp:57)     "<nick> is an unconfirmed nickname."
  //   Anope   (ns_register.cpp:281)        "Your email address is not confirmed."
  //   Anope   (ns_register.cpp:540)        "Your account will expire, if not confirmed, in ..."
  //   Atheme  (info.c:490)                 "<nick> has NOT COMPLETED registration verification."
  //   Atheme  (identify.c:70)              "Please check your email for instructions to complete your registration."
  //   Ergo    (errors.go:30)               "Account is not yet verified"
  //
  // MUST come before registration-pending because Atheme's
  // post-identify nag "check your email for instructions to complete
  // your registration" also matches the looser "check your email for"
  // pending pattern. The distinction: unconfirmed means we're
  // already identified but the account-side verification is still
  // pending (user can chat; account will expire if not finished),
  // whereas pending means we just registered and aren't yet
  // identified.
  //
  // Also above registration-confirmed because Anope's expiration nag
  // ("Your account will expire, if not confirmed") would otherwise
  // false-match the looser `account.*confirmed` catch-all below.
  { kind: 'account-unconfirmed', rx: /\bis an unconfirmed nickname\b/i },
  { kind: 'account-unconfirmed', rx: /\bemail address is not confirmed\b/i },
  { kind: 'account-unconfirmed', rx: /\bwill expire, if not confirmed\b/i },
  { kind: 'account-unconfirmed', rx: /\bnot completed\b.*\bregistration verification\b/i },
  { kind: 'account-unconfirmed', rx: /\bcheck your email\b.*\bcomplete your registration\b/i },
  { kind: 'account-unconfirmed', rx: /\baccount is not yet verified\b/i },

  // ---- registration-pending --------------------------------------------
  //   Anope    "Please type \"/msg NickServ CONFIRM <code>\" to confirm"
  //   Atheme   (register.c:192) "An email containing nickname activation
  //              instructions has been sent to <addr>."
  //            (register.c:194) "If you do not complete registration within
  //              one day, your nickname will expire."
  //   Ergo     (nickserv.go:1031) "Account created, pending verification;
  //              verification code has been sent to <addr>"
  //
  // Note: no leading word-boundary on `/msg` — `/` is a non-word
  // character so `\b/` only matches when preceded by a word char,
  // which fails for quoted forms like `"/msg`.
  // Ergo's pending pattern is listed BEFORE the generic "Account
  // created" registration-confirmed line so the order resolves to
  // "pending" when both phrasings would match.
  { kind: 'registration-pending', rx: /\/msg\s+nickserv\s+confirm\b/i },
  { kind: 'registration-pending', rx: /\bverify your email\b/i },
  { kind: 'registration-pending', rx: /\bcheck your (?:e-?mail|inbox) for\b/i },
  { kind: 'registration-pending', rx: /\bemail verification\b.*\bsent\b/i },
  { kind: 'registration-pending', rx: /\bactivation instructions\b.*\bsent\b/i },
  { kind: 'registration-pending', rx: /\baccount created.*pending verification\b/i },
  { kind: 'registration-pending', rx: /\bverification code\b.*\bsent\b/i },

  // ---- registration-confirmed ------------------------------------------
  //   Anope     (live)            "Your email address of <addr> has been confirmed."
  //   Anope                       "Your account is now confirmed."
  //   Atheme    (verify.c:12,13)  "Thank you for verifying your e-mail address!"
  //                               "<account> has now been verified."
  //   Atheme    (verify.c:74,103) "<name> is not awaiting verification."   (i.e. already done)
  //   Ergo      (handlers.go:101) "Account created"
  //   Ergo      (numeric REGISTER VERIFY SUCCESS)
  //                               "... Account successfully registered"
  //   No-confirm flows (e.g. CSConfirm disabled on Anope, Ergo's default,
  //   Atheme networks with `nickserv::no_nick_ownership`) yield
  //   "Your nickname <X> has been registered." in one reply — same kind.
  //
  // Ordered AFTER registration-pending + account-unconfirmed so a
  // reply mentioning BOTH "registered" AND "please confirm" lands as
  // pending, and "if not confirmed" lands as unconfirmed.
  // `account.*is.*confirmed` is tighter than the prior `account.*confirmed`
  // catch-all (which false-matched "if not confirmed").
  { kind: 'registration-confirmed', rx: /\baccount\b.*\bis\s+(?:now\s+)?confirmed\b/i },
  { kind: 'registration-confirmed', rx: /\bemail verification complete\b/i },
  { kind: 'registration-confirmed', rx: /\bregistration .* (?:complete|successful)\b/i },
  { kind: 'registration-confirmed', rx: /\bemail address\b.*\bhas been confirmed\b/i },
  // Atheme post-VERIFY success — "<account> has now been verified."
  { kind: 'registration-confirmed', rx: /\bhas now been verified\b/i },
  // Atheme "already verified" reply — VERIFY on a confirmed account.
  // Same end state: the account is verified.
  { kind: 'registration-confirmed', rx: /\bis not awaiting verification\b/i },
  // No-confirm direct-success patterns. "Your nickname alice has
  // been registered.", "Account alice registered.",
  // "Account created" (Ergo's instant-register without email).
  // Anope's live phrasing wraps the nick in bold (\x02) bytes:
  // "Nickname \x02e2ereg123\x02 registered." — `\S+` covers those
  // since they aren't whitespace.
  //
  // The `(?!is\b)` negative lookahead is what distinguishes
  // "Nickname <X> registered." (success) from "This nickname is
  // registered" (the first-touch prompt). Without it the looser
  // pattern would false-match the prompt — caught by the
  // services.fixtures.test.ts replay of live Anope output.
  { kind: 'registration-confirmed', rx: /\b(?:nickname|account)\b[^.]*\bhas been registered\b/i },
  { kind: 'registration-confirmed', rx: /\b(?:nickname|account)\s+(?!is\b)\S+\s+registered\b/i },
  { kind: 'registration-confirmed', rx: /\bsuccessfully registered\b/i },
  { kind: 'registration-confirmed', rx: /\baccount created\b/i },
  // Atheme 7.2.x post-REGISTER: "<name> is now registered to <email>".
  // Captured live in fixtures/atheme/register-no-confirm.json.
  { kind: 'registration-confirmed', rx: /\bis now registered to\b/i },

  // First-touch prompt — "This nickname is registered, please identify..."
  { kind: 'nick-registered-prompt', rx: /\bthis nickname is registered\b/i },
  { kind: 'nick-registered-prompt', rx: /\bnick(?:name)? is owned by\b/i },

  // ---- drop-success ----------------------------------------------------
  //   Anope     "Nickname X has been dropped." / "Your account has been dropped."
  //   Atheme    (drop.c:114) "The account X has been dropped."
  //   Atheme                  "X is no longer registered."
  //   Ergo      (nickserv.go:1153) "Successfully unregistered account X"
  { kind: 'drop-success', rx: /\bhas been dropped\b/i },
  { kind: 'drop-success', rx: /\bis no longer registered\b/i },
  { kind: 'drop-success', rx: /\baccount\b.*\bdropped\b/i },
  { kind: 'drop-success', rx: /\bsuccessfully unregistered\b/i },

  // Generic verbatim-replay prompt. Matches any reply that gives us an
  // inline `/msg NickServ ...` command to echo back. Captures it and
  // replays. Handles:
  //   * Atheme's "Please confirm by replying with /msg NickServ
  //     DROP <acct> <pw> <token>"
  //   * Atheme/Libera's drop.c second-step:
  //     "To complete the drop of <acct>, you must reply with:
  //      /msg NickServ DROP <acct> <key>"
  //     (drop.c:78 — verified live on irc.libera.chat). The KEY is a
  //     server-generated token; we MUST replay this verbatim — if we
  //     re-send the password instead, Atheme replies "Invalid key
  //     for DROP." and the user is stuck.
  //   * Atheme verify.c email-confirmation:
  //     "you must reply with: /msg NickServ VERIFY REGISTER <acct> <code>"
  //   * irc.boson.chat's 3-arg Anope variant "/msg NickServ DROP
  //     <nick> <hostmask> <token>"
  //   * The canonical Anope "To confirm, type: /msg NickServ DROP
  //     CONFIRM" (subsumed — `to confirm.*\/msg` is enough)
  //
  // Listed FIRST so the more-specific verbatim-replay handler wins
  // over the looser drop-confirm-prompt fallback below. Accepts
  // either the long `/msg NickServ <verb>` form (Atheme + Anope)
  // or the `/NS <verb>` shorthand (Ergo + many clients) — the
  // replay handler in chat.service.ts normalizes both into a
  // PRIVMSG to the NickServ target.
  //
  // Pattern shape: an "imperative + inline command" phrase, followed
  // anywhere in the line by `/msg NickServ` or `/NS`. The phrase
  // alternation captures:
  //   - "please confirm by replying [with]"  (Atheme docker DROP prompt)
  //   - "to confirm, type" / "to confirm: run this command"  (Anope)
  //   - "you must reply with" / "you must respond with"      (Atheme/Libera)
  //   - "to complete the drop ... reply with"                (Atheme drop.c)
  //
  // Deliberately strict — earlier iterations included a bare
  // `reply with` alternation which false-matched info notices like
  // "If you need help, reply with /msg NickServ HELP for assistance",
  // causing a replay loop. Every legitimate replay-prompt phrasing
  // observed in Atheme + Anope + Ergo source carries one of the four
  // imperative anchors above; the bare `reply with` tail is gone.
  { kind: 'service-confirm-replay', rx: /\b(?:please\s+confirm\s+by\s+replying|to\s+confirm[,:]?\s+(?:type[d,:]?|run\s+this\s+command)|you\s+must\s+(?:reply|respond)\s+with|to\s+complete\b[^/]*\breply\s+with)\b[^/]*\/(?:msg\s+nickserv|ns)\s+/i },

  // Fallback drop-confirm-prompt — matches the SHAPE of a confirm
  // prompt without an inline command. Anope canonical "DROP
  // CONFIRM" mention is enough; ChatService fires the literal
  // verb. Rarely hit now that service-confirm-replay catches the
  // common cases.
  { kind: 'drop-confirm-prompt', rx: /\bto confirm\b.*\b(?:drop|unregister)\b/i },
  { kind: 'drop-confirm-prompt', rx: /\bdrop\s+confirm\b/i },

  // "Syntax: DROP <account> <password>" — production-Anope variants
  // require 2 args. Caught live on irc.boson.chat. ChatService
  // auto-retries with the saved password appended. No trailing `\b`
  // because both sides of `>` are non-word characters and the
  // engine equates them as "same class" (no boundary).
  { kind: 'drop-needs-password', rx: /\bsyntax:\s*drop\s+<account>\s+<password>/i },

  // Atheme's "Invalid key for DROP." (drop.c:60 — fault_badparams).
  // Means we sent the wrong second-step token. Classified as
  // drop-failed so the UI can show a distinct "drop key mismatch —
  // try again from the Identity panel" message rather than a generic
  // identify-failed. Sits below 'service-confirm-replay' so an
  // upstream prompt that includes the key gets replayed first.
  { kind: 'drop-failed', rx: /\binvalid\s+key\s+for\s+drop\b/i },

  // ---- RESEND replies (Anope only) -----------------------------------
  //   Anope success (ns_register.cpp:412):
  //     "The confirmation code for <nick> has been re-sent to <email>."
  //   Anope cooldown (ns_register.cpp:400):
  //     "Cannot send mail now; please retry a little later."
  //
  // Atheme + Ergo have no upstream RESEND so these patterns are
  // Anope-exclusive in practice. We match on a small substring so
  // hyphenation drift ("re-sent" vs "resent") doesn't break us.
  { kind: 'resend-success',  rx: /\bhas been re-?sent to\b/i },
  { kind: 'resend-cooldown', rx: /\bcannot send mail now\b/i },
];

// Classify a NickServ NOTICE/PRIVMSG body. Returns the first matching
// pattern's kind, or null for anything we don't surface as a status
// transition. Caller should treat null as "leave the persisted status
// alone" — not as "no status".
// IRCv3 inline-formatting bytes that show up in real NickServ
// replies. Bold (\x02), italic (\x1d), underline (\x1f), strike
// (\x1e), monospace (\x11), reverse (\x16), color-reset / format-
// terminator (\x0f). Real fixtures from Atheme/Anope frequently
// wrap nicks + commands in \x02 pairs; the patterns are written
// for plain text, so strip these before matching.
const FORMATTING_BYTES_RX = /[\x02\x0f\x11\x16\x1d\x1e\x1f]/g;

export function classifyNickServReply(body: string): NickServReplyKind | null {
  if (!body) return null;
  const stripped = body.replace(FORMATTING_BYTES_RX, '');
  for (const { kind, rx } of NICKSERV_PATTERNS) {
    if (rx.test(stripped)) return kind;
  }
  return null;
}

// Map a classified reply onto the persisted AccountStatus the UI
// renders. Centralised here so the ChatService stays a thin
// dispatcher and the mapping is unit-testable without spinning up a
// fake session.
//
// Returns null when we don't want to touch the persisted status —
// for `nick-registered-prompt`, the right move is "leave the saved
// status alone" because the prompt tells us nothing about whether
// our IDENTIFY succeeded.
export function nickServReplyToStatus(kind: NickServReplyKind): AccountStatusFromReply | null {
  switch (kind) {
    case 'identified-success':     return 'identified';
    case 'identify-failed':        return 'identify-failed';
    case 'registration-pending':   return 'pending-confirmation';
    case 'registration-confirmed': return 'registered';
    case 'account-unconfirmed':    return 'identified-unconfirmed';
    case 'nick-registered-prompt': return null;
    case 'drop-success':           return 'no-account';
    // 'drop-failed' (Atheme "Invalid key for DROP.") is a UI-side
    // signal — the account is still there, just the drop request
    // failed. ChatService re-emits a chat-area notice; the persisted
    // status doesn't move. The renderer panel listens for the kind
    // separately via the chat-event stream.
    case 'drop-failed':            return null;
    // 'drop-confirm-prompt' is a side-effect signal (ChatService
    // auto-fires DROP CONFIRM); it shouldn't bump the persisted
    // status on its own.
    case 'drop-confirm-prompt':    return null;
    // 'drop-needs-password' is the same shape: ChatService auto-
    // retries the DROP with the saved password — no status change.
    case 'drop-needs-password':    return null;
    // 'service-confirm-replay' is a side-effect signal: ChatService
    // parses the inline `/msg NickServ ...` command from the
    // prompt body and replays it verbatim. No status change.
    case 'service-confirm-replay': return null;
    // 'resend-success' and 'resend-cooldown' don't move the
    // persisted account status (it stays 'pending-confirmation').
    // The Identity panel watches for these via its own subscribe
    // on the credentials store + a transient toast/flag.
    case 'resend-success':         return null;
    case 'resend-cooldown':        return null;
  }
}

// Type alias to avoid an import cycle from services-credentials.ts.
// The value space is identical to `AccountStatus` minus the states
// the classifier can't observe ('unknown', 'no-account' come from
// elsewhere). We keep this as a string literal union rather than
// importing the canonical type so this module stays a pure helper
// with no module-dependency on the credentials store.
export type AccountStatusFromReply =
  | 'identified'
  | 'identified-unconfirmed'
  | 'identify-failed'
  | 'pending-confirmation'
  | 'registered'
  | 'no-account';

// The "flavour" of services package the network is running. Atheme and
// Anope are the dominant implementations; their command surfaces overlap
// but diverge enough (atheme's `GROUP` vs. anope's `CONFIRM`, different
// `SET` keys, etc.) that the UI wants to know which one it's talking to.
// `unknown` means we've seen a service interact but couldn't identify
// the package (uncommon — most banners are distinctive); `null` means
// no service has interacted yet.
export type ServicesFramework = 'atheme' | 'anope' | 'ergo' | 'unknown' | null;

// Classify a NOTICE / PRIVMSG body from a service into one of the known
// frameworks. Returns null when no signature is found. Match is case-
// insensitive — both packages name themselves identically across all
// their services (NickServ, ChanServ, MemoServ, HostServ, etc.), so a
// substring match against any service's response is enough.
//
// Sources surveyed (from Atheme + Anope source / docs):
//
//   Atheme (atheme.org):
//     VERSION reply           — "atheme-7.X.Y. Compiled on ..."
//     HELP banner header      — "Atheme IRC Services 7.X.Y."
//     Generic footer          — "(C) atheme.org"
//     Some networks brand it  — "Powered by Atheme"
//
//   Anope (anope.org):
//     VERSION reply           — "Anope-2.0.X" or "Anope IRC Services 2.0.X"
//     HELP banner header      — "Anope IRC Services Help System"
//     Module banners          — "Anope module: ...", "Anope-..."
//
// We accept the bare word `Anope` or `Atheme` anywhere in the body. The
// false-positive risk on normal English is essentially nil — neither
// word is a common noun and they basically never appear in chat
// transcripts outside their own banners.
export function detectServicesFramework(noticeBody: string): ServicesFramework {
  if (!noticeBody) return null;
  // Word-boundary match avoids matching e.g. "panopent" against "anope".
  // Case-insensitive flag makes "ATHEME" / "atheme" / "Atheme" all match.
  if (/\batheme\b/i.test(noticeBody)) return 'atheme';
  if (/\banope\b/i.test(noticeBody)) return 'anope';
  return null;
}
