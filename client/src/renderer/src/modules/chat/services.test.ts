import { describe, it, expect } from 'vitest';
import {
  classifyNickServReply,
  detectServicesFramework,
  isNickServSender,
  isServiceSender,
  nickServReplyToStatus,
  type NickServReplyKind,
} from './services';

describe('isServiceSender', () => {
  it.each([
    'NickServ', 'nickserv', 'ChanServ', 'OperServ', 'MemoServ',
    'BotServ', 'HostServ', 'SaslServ', 'global',
  ])('recognises %s as a service', (nick) => {
    expect(isServiceSender(nick)).toBe(true);
  });

  it('recognises server-hostname sender (contains a dot)', () => {
    expect(isServiceSender('hub.example.org')).toBe(true);
  });

  it('rejects ordinary nicks', () => {
    expect(isServiceSender('alice')).toBe(false);
    expect(isServiceSender('Bob_42')).toBe(false);
  });

  it('treats an empty sender as server-side (anonymous notice)', () => {
    expect(isServiceSender('')).toBe(true);
  });
});

describe('detectServicesFramework', () => {
  it('classifies Atheme by its name in the banner', () => {
    expect(detectServicesFramework(
      'This nickname is registered. atheme.org for help.',
    )).toBe('atheme');
    expect(detectServicesFramework('atheme-7.2.12')).toBe('atheme');
    expect(detectServicesFramework('Powered by Atheme IRC Services')).toBe('atheme');
  });

  it('classifies Anope by its versioned signature or "Anope IRC Services"', () => {
    expect(detectServicesFramework('Anope-2.0.10 — see /msg NickServ HELP')).toBe('anope');
    expect(detectServicesFramework('Anope IRC Services version 2.0')).toBe('anope');
  });

  it('returns null when neither signature is present', () => {
    expect(detectServicesFramework('Welcome to the network!')).toBeNull();
    expect(detectServicesFramework('This nickname is registered.')).toBeNull();
  });

  it('uses word-boundary matching — substrings within longer words do not match', () => {
    // Guard against false positives like "panopent" / "atheme-like".
    expect(detectServicesFramework('panopent and friends')).toBeNull();
    expect(detectServicesFramework('athemeoid behaviour')).toBeNull();
  });

  it('accepts the bare word "Anope" anywhere in a service banner', () => {
    // Service contexts only — `detectServicesFramework` is only called
    // from `isServiceSender` branches, so a bare "Anope" inside a real
    // service NOTICE is almost certainly the package name.
    expect(detectServicesFramework('Welcome — Anope')).toBe('anope');
  });

  it('returns null for empty input', () => {
    expect(detectServicesFramework('')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(detectServicesFramework('ATHEME version 7')).toBe('atheme');
    expect(detectServicesFramework('anope ircd services')).toBe('anope');
  });
});

// classifyNickServReply test table — patterns sourced from real
// NickServ banner output across Atheme + Anope (referenced in the
// boson-irc-cmd skill + live observations on irc.boson.chat). The
// table form keeps Atheme + Anope phrasings side-by-side so divergent
// updates are obvious in PRs.
describe('classifyNickServReply', () => {
  const cases: Array<{ body: string; want: NickServReplyKind | null; note: string }> = [
    // identified-success
    { body: 'You are now identified for alice.', want: 'identified-success', note: 'atheme — canonical' },
    { body: 'Password accepted - you are now recognized.', want: 'identified-success', note: 'anope — canonical' },
    { body: 'You are now identified for alice (logged in)', want: 'identified-success', note: 'atheme — with trailing' },
    { body: 'You are already identified.', want: 'identified-success', note: 'observed on irc.boson.chat (Anope) — same end-state' },
    { body: 'You are now logged in as alice.', want: 'identified-success', note: 'atheme — no_nick_ownership variant' },
    { body: "You are already logged in as alice.", want: 'identified-success', note: 'atheme — already-identified' },
    { body: "You're now logged in as alice.", want: 'identified-success', note: 'ergo — fresh login' },
    { body: "You're already logged into an account.", want: 'identified-success', note: 'ergo — already-identified' },

    // identify-failed
    { body: 'Invalid password for alice.', want: 'identify-failed', note: 'atheme — wrong password' },
    { body: 'Password incorrect.', want: 'identify-failed', note: 'anope — wrong password' },
    { body: 'Authentication failed.', want: 'identify-failed', note: 'generic — Ergo / others' },
    { body: 'No such account: alice', want: 'identify-failed', note: 'no account exists' },
    { body: 'No such nick: bob', want: 'identify-failed', note: 'no such nick variant' },
    { body: 'alice is not a registered nickname.', want: 'identify-failed', note: 'atheme identify.c:63' },
    { body: 'Authentication failed: Invalid account credentials', want: 'identify-failed', note: 'ergo wrong password' },
    { body: 'Authentication failed: Account does not exist', want: 'identify-failed', note: 'ergo no such account' },
    { body: 'Authentication failed: Account has been suspended', want: 'identify-failed', note: 'ergo suspended' },
    // Anope NICK_X_NOT_REGISTERED — issued on IDENTIFY/INFO/DROP
    // against a nick that doesn't exist. Format prints both the
    // looked-up nick and the source mask in the %s slot.
    { body: "Nick alice ~user@host.example isn't registered.", want: 'identify-failed', note: 'anope NICK_X_NOT_REGISTERED — observed live; nick + source mask in the %s slot' },
    { body: "Nick alice isn't registered.", want: 'identify-failed', note: 'anope plain — no source mask' },
    { body: "alice isnt registered.", want: 'identify-failed', note: 'tolerant of stripped apostrophe (locale)' },

    // registration-pending
    { body: 'Please type "/msg NickServ CONFIRM abc123" to confirm', want: 'registration-pending', note: 'anope CONFIRM prompt' },
    { body: 'Please verify your email address by clicking the link sent to ...', want: 'registration-pending', note: 'atheme verify-email prompt' },
    { body: 'Please check your email for verification instructions.', want: 'registration-pending', note: 'atheme — check email' },
    { body: 'An email containing nickname activation instructions has been sent to alice@example.com.', want: 'registration-pending', note: 'atheme register.c:192' },
    { body: 'Account created, pending verification; verification code has been sent to alice@example.com', want: 'registration-pending', note: 'ergo nickserv.go:1031' },

    // registration-confirmed (post-confirm + no-confirm flows)
    { body: 'Your account is now confirmed.', want: 'registration-confirmed', note: 'anope — confirmed' },
    { body: 'Email verification complete.', want: 'registration-confirmed', note: 'atheme — verified' },
    { body: 'Registration is now complete.', want: 'registration-confirmed', note: 'generic — done' },
    { body: 'Your nickname alice has been registered.', want: 'registration-confirmed', note: 'no-confirm flow — anope variant' },
    { body: 'Account alice registered.', want: 'registration-confirmed', note: 'short-form direct success' },
    { body: 'You have successfully registered alice.', want: 'registration-confirmed', note: 'atheme — direct success' },
    // Confirm-prompt precedence: even with "has been registered" present,
    // the "please type CONFIRM" pattern wins because it appears earlier
    // in the pattern table. Pins the precedence guarantee.
    { body: 'Your nickname alice has been registered. Please type "/msg NickServ CONFIRM ab12" to confirm.', want: 'registration-pending', note: 'confirm-prompt wins over has-been-registered' },
    // Anope post-CONFIRM success — observed live on irc.boson.chat
    // after entering the confirmation code from the email.
    { body: 'Your email address of hi+nyan@boson.chat has been confirmed.', want: 'registration-confirmed', note: 'anope post-CONFIRM success' },
    { body: 'Your email address has been confirmed.', want: 'registration-confirmed', note: 'anope no-addr variant' },
    { body: 'alice has now been verified.', want: 'registration-confirmed', note: 'atheme verify.c:13 post-VERIFY success' },
    { body: 'alice is not awaiting verification.', want: 'registration-confirmed', note: 'atheme verify.c:74 — already verified' },
    { body: 'Account created', want: 'registration-confirmed', note: 'ergo instant-register without email' },

    // nick-registered-prompt — the first-touch nudge on join
    { body: 'This nickname is registered. Please choose a different nickname or identify via /msg NickServ identify <password>.', want: 'nick-registered-prompt', note: 'common phrasing' },
    { body: 'This nickname is owned by someone else.', want: 'nick-registered-prompt', note: 'older variant' },

    // account-unconfirmed — account exists/identified but email-verify pending
    { body: 'Nyan is an unconfirmed nickname.', want: 'account-unconfirmed', note: 'anope INFO — observed live on irc.boson.chat' },
    { body: 'Your email address is not confirmed. To confirm it, follow the instructions that were emailed to you.', want: 'account-unconfirmed', note: 'anope post-identify nag' },
    { body: 'Your account will expire, if not confirmed, in 23 hours, 55 minutes.', want: 'account-unconfirmed', note: 'anope expiration warning' },
    { body: 'alice has NOT COMPLETED registration verification.', want: 'account-unconfirmed', note: 'atheme — MU_WAITAUTH info line (bold bytes stripped)' },
    { body: 'Please check your email for instructions to complete your registration.', want: 'account-unconfirmed', note: 'atheme identify.c:70 — post-identify nag' },
    { body: 'Account is not yet verified', want: 'account-unconfirmed', note: 'ergo errors.go:30' },

    // drop-success — DROP completed
    { body: 'Nickname Nyan has been dropped.', want: 'drop-success', note: 'anope — canonical' },
    { body: 'The account alice has been dropped.', want: 'drop-success', note: 'atheme — canonical' },
    { body: 'Your account is no longer registered.', want: 'drop-success', note: 'atheme variant' },
    { body: 'Account alice dropped.', want: 'drop-success', note: 'short form' },
    { body: 'Successfully unregistered account alice', want: 'drop-success', note: 'ergo nickserv.go:1153' },

    // drop-confirm-prompt — fallback for cases without an inline
    // `/msg NickServ` command. The canonical Anope "DROP CONFIRM"
    // prompt now matches service-confirm-replay first (since it
    // includes `/msg NickServ DROP CONFIRM` inline), which ends up
    // with the same effect (replays "DROP CONFIRM" verbatim).
    { body: 'To confirm, type: /msg NickServ DROP CONFIRM', want: 'service-confirm-replay', note: 'anope canonical — service-confirm-replay subsumes' },
    { body: 'To confirm the deletion, please type DROP CONFIRM', want: 'drop-confirm-prompt', note: 'no inline /msg — fallback to drop-confirm-prompt' },

    // drop-needs-password — production-Anope variant that requires
    // 2 args to ns_drop and rejects single-arg with this syntax
    // hint. Observed live on irc.boson.chat.
    { body: 'Syntax: DROP <account> <password>', want: 'drop-needs-password', note: 'production anope ns_drop 2-arg' },

    // resend-success / resend-cooldown — Anope's RESEND replies.
    // Both ns_register.cpp templates. Verified phrasings:
    {
      body: 'The confirmation code for alice has been re-sent to alice@example.com.',
      want: 'resend-success',
      note: 'anope resend success (hyphenated re-sent)',
    },
    {
      body: 'The confirmation code for alice has been resent to alice@example.com.',
      want: 'resend-success',
      note: 'anope resend success (unhyphenated variant)',
    },
    {
      body: 'Cannot send mail now; please retry a little later.',
      want: 'resend-cooldown',
      note: 'anope resend cooldown',
    },

    // service-confirm-replay — generic "paste this command back"
    // prompt that defies template categorization (Atheme's
    // token-based confirm AND irc.boson.chat's 3-arg DROP both
    // phrase it this way).
    {
      body: 'Please confirm by replying with /msg NickServ DROP alice ~user@host.example abc123:def456',
      want: 'service-confirm-replay',
      note: 'anope variant — 3-arg DROP with source mask + token',
    },
    {
      body: 'Please confirm by replying with /msg NickServ DROP alice hunter2 4f8b515b',
      want: 'service-confirm-replay',
      note: 'atheme — DROP <account> <password> <token>',
    },
    // Atheme/Libera drop.c:78 — two-step DROP where the second step
    // requires a server-issued KEY (NOT the password). Replaying the
    // inline command verbatim is mandatory; re-sending the password
    // would land us on "Invalid key for DROP." instead.
    {
      body: 'To complete the drop of alice, you must reply with: /msg NickServ DROP alice ab12cd34ef',
      want: 'service-confirm-replay',
      note: 'atheme libera — drop.c two-step key replay',
    },
    {
      body: 'you must reply with: /msg NickServ VERIFY REGISTER alice ab12cd34ef',
      want: 'service-confirm-replay',
      note: 'atheme verify.c — VERIFY REGISTER key replay',
    },

    // drop-failed — Atheme's wrong-key reply on the two-step DROP.
    // Means a previous replay sent the wrong token (or the user
    // typed it manually). Account is still registered.
    {
      body: 'Invalid key for DROP.',
      want: 'drop-failed',
      note: 'atheme drop.c:60 — wrong second-step key',
    },

    // Negative regression — these MUST NOT classify as
    // service-confirm-replay. Earlier iterations included a bare
    // `reply with` alternation that false-matched these, causing
    // an auto-replay loop after a successful drop or any info
    // notice that mentioned /msg NickServ.
    {
      body: 'Unknown command "HELP". "/msg NickServ HELP" for help.',
      want: null,
      note: 'anope post-drop noise — must not trigger replay',
    },
    {
      body: 'If you need help, reply with /msg NickServ HELP for assistance.',
      want: null,
      note: 'prose with `reply with /msg NickServ HELP` — must not replay',
    },
    {
      body: 'To register, type /msg NickServ REGISTER <password> <email>.',
      want: null,
      note: 'help text describing REGISTER — must not auto-fire REGISTER',
    },

    // null — patterns we don't surface
    { body: 'Welcome to the network!', want: null, note: 'unrelated NOTICE' },
    { body: 'You have 2 new memos.', want: null, note: 'memo notice (handled separately)' },
    { body: '', want: null, note: 'empty body' },
  ];
  for (const tc of cases) {
    it(`${tc.note} — "${tc.body.slice(0, 60)}${tc.body.length > 60 ? '…' : ''}"`, () => {
      expect(classifyNickServReply(tc.body)).toBe(tc.want);
    });
  }
});

describe('nickServReplyToStatus', () => {
  it('maps each reply kind to the right persisted AccountStatus', () => {
    expect(nickServReplyToStatus('identified-success')).toBe('identified');
    expect(nickServReplyToStatus('identify-failed')).toBe('identify-failed');
    expect(nickServReplyToStatus('registration-pending')).toBe('pending-confirmation');
    expect(nickServReplyToStatus('registration-confirmed')).toBe('registered');
    expect(nickServReplyToStatus('drop-success')).toBe('no-account');
    expect(nickServReplyToStatus('account-unconfirmed')).toBe('identified-unconfirmed');
  });

  it("returns null for 'drop-confirm-prompt' (side-effect signal, not a persisted state)", () => {
    // ChatService catches this kind to auto-fire DROP CONFIRM; the
    // persisted status field shouldn't move on its own.
    expect(nickServReplyToStatus('drop-confirm-prompt')).toBeNull();
  });

  it("returns null for 'drop-needs-password' (side-effect signal, not a persisted state)", () => {
    // ChatService catches this kind to auto-fire the 2-arg DROP
    // form for production-Anope variants; the persisted status
    // field shouldn't move on its own.
    expect(nickServReplyToStatus('drop-needs-password')).toBeNull();
  });

  it("returns null for 'drop-failed' (account still exists; status untouched)", () => {
    // Atheme's "Invalid key for DROP." — the drop didn't go through,
    // but the account is still registered. Don't move the persisted
    // status; the UI surfaces a chat-area notice separately.
    expect(nickServReplyToStatus('drop-failed')).toBeNull();
  });

  it("returns null for 'resend-success' and 'resend-cooldown' (status stays pending-confirmation)", () => {
    // Resending is a side-effect — the account is still pending
    // until the user enters the code. The persisted status field
    // shouldn't move for either outcome.
    expect(nickServReplyToStatus('resend-success')).toBeNull();
    expect(nickServReplyToStatus('resend-cooldown')).toBeNull();
  });

  it('returns null for nick-registered-prompt (leaves persisted status alone)', () => {
    // Rationale: the prompt only says "this nick is registered" — it
    // doesn't tell us whether OUR identify succeeded, so we don't
    // want to overwrite a previously-good 'identified' state.
    expect(nickServReplyToStatus('nick-registered-prompt')).toBeNull();
  });
});

describe('isNickServSender', () => {
  it.each(['NickServ', 'nickserv', 'NICKSERV', 'NickServ'])('accepts %s', (nick) => {
    expect(isNickServSender(nick)).toBe(true);
  });
  it('rejects unrelated nicks', () => {
    expect(isNickServSender('MemoServ')).toBe(false);
    expect(isNickServSender('alice')).toBe(false);
    expect(isNickServSender('')).toBe(false);
  });
});
