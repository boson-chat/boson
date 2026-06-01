// AthemeAccountService — the Atheme-specific implementation of the
// AccountService interface.
//
// Atheme's distinguishing feature for this step is its DROP flow:
// a two-step KEY replay, not a password re-fire. The first DROP
// receives a server-issued nonce in the reply; we MUST echo back
// the nonce, not the password. Sending the password instead lands
// us on "Invalid key for DROP." — verified live on irc.libera.chat.
//
// Source-of-truth: atheme/modules/nickserv/drop.c.
//   - 78: "To complete the drop of \2%s\2, you must reply with: ..."
//   - 60: "Invalid key for DROP."
//
// Other methods (register/identify/confirm/info/resend) are stubs
// until Steps 5–8 migrate them.

import type { IrcEvent } from '../engine/engine.types';
import type { ServerSession } from '../engine/engine.client';
import type {
  AccountService,
  RegisterResult,
  IdentifyResult,
  ConfirmResult,
  DropResult,
  AccountInfo,
  ResendResult,
  UnsupportedResult,
} from './account-service';
import type { AccountStatus } from './services-credentials';
import { isNickServSender } from './services';
import { REPLAY_PHRASES, extractInlineNickservCommand, stripFormat, runIdentify, runRegister, runConfirm, OperationGuard } from './account-service-helpers';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface AthemeAccountServiceOpts {
  myNick: string;
  timeoutMs?: number;
}

export class AthemeAccountService implements AccountService {
  readonly framework = 'atheme' as const;

  private readonly session: ServerSession;
  private readonly opts: Required<AthemeAccountServiceOpts>;
  private readonly statusListeners = new Set<(s: AccountStatus | undefined) => void>();
  private currentStatus: AccountStatus | undefined;
  // Critical on Atheme — duplicate drop() lands the second replay
  // with a stale server-issued key → "Invalid key for DROP".
  private readonly guard = new OperationGuard();

  constructor(session: ServerSession, opts: AthemeAccountServiceOpts) {
    this.session = session;
    this.opts = {
      myNick: opts.myNick,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  // ---- drop() — the operation this step migrates -------------------
  //
  // Atheme DROP is always two-step (verified live across Libera +
  // dockerised Atheme 7.2.x):
  //
  //   1. Send `DROP <acct> <pw>` (2-arg, required).
  //   2. Server replies with one of:
  //      - "To complete the drop of <acct>, you must reply with:
  //         /msg NickServ DROP <acct> <KEY>"        (drop.c:78)
  //      - "Please confirm by replying with /msg NickServ DROP
  //         <acct> <pw> <token>"                    (docker variant)
  //      Either way, the server's inline command is the EXACT
  //      follow-up we must fire. Re-sending the password as the
  //      second arg lands us on "Invalid key for DROP."
  //   3. Echo the inline command verbatim.
  //   4. Server replies "<acct> has been dropped." → resolve dropped.
  //
  // Failure paths:
  //   - "Invalid key for DROP."          → failed (reason='invalid-key')
  //   - "<acct> is not registered."      → no-such-account
  //   - "Authentication failed" /        → wrong-password
  //     "Invalid password for <acct>"
  //
  // The 2-arg requirement for the FIRST step means a wrong password
  // is caught immediately by the server; we don't have an Anope-style
  // fallback dance here.
  async drop(accountName: string, password: string): Promise<DropResult> {
    return this.guard.dedupe('drop', () => new Promise<DropResult>((resolve) => {
      let resolved = false;
      let unsubscribe: () => void = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: DropResult): void => {
        if (resolved) return;
        resolved = true;
        unsubscribe();
        if (timer) clearTimeout(timer);
        resolve(result);
      };

      timer = setTimeout(
        () => finish({ kind: 'failed', reason: 'timeout' }),
        this.opts.timeoutMs,
      );

      unsubscribe = this.session.onEvent((e: IrcEvent) => {
        if (e.Kind !== 'NOTICE') return;
        if (!isNickServSender(e.From)) return;
        if (e.Target !== this.opts.myNick) return;

        const body = stripFormat(e.Message);

        // Two-step KEY replay. The server tells us EXACTLY what to
        // echo back; we must replay it verbatim, including any
        // server-issued token. Sending the password as the second
        // arg here lands us on "Invalid key for DROP."
        if (REPLAY_PHRASES.test(body)) {
          const cmd = extractInlineNickservCommand(body);
          if (cmd) {
            this.session.privmsg('NickServ', cmd);
            return;
          }
          finish({ kind: 'failed', reason: 'could-not-parse-inline-command' });
          return;
        }

        // Terminal: success. Atheme's drop.c:114 — "The account
        // \2%s\2 has been dropped." The looser "is no longer
        // registered" variant catches translated/alternative builds.
        if (/\bhas been dropped\b/i.test(body) || /\bis no longer registered\b/i.test(body)) {
          finish({ kind: 'dropped' });
          return;
        }

        // Terminal: wrong second-step KEY. Indicates a parse bug on
        // our side OR the user typed the wrong follow-up manually.
        // Surface as `failed` with a specific reason so the panel
        // can suggest a retry.
        if (/\binvalid key for drop\b/i.test(body)) {
          finish({ kind: 'failed', reason: 'invalid-key' });
          return;
        }

        // Terminal: wrong password on the first step. Atheme's
        // identify.c phrasing: "Invalid password for <acct>" /
        // "Authentication failed". drop.c re-uses identify-style
        // auth checks before issuing a key.
        if (/\binvalid password\b/i.test(body) || /\bauthentication failed\b/i.test(body)) {
          finish({ kind: 'wrong-password' });
          return;
        }

        // Terminal: account doesn't exist. Atheme: "<X> is not
        // registered." (drop.c:60-style fault). Tolerate the
        // contraction variant too (Anope-derived phrasings).
        if (/\bis not (?:a )?registered\b/i.test(body) || /\bisn'?t registered\b/i.test(body)) {
          finish({ kind: 'no-such-account' });
          return;
        }
      });

      // Kick off: Atheme requires 2-arg from the start.
      this.session.privmsg('NickServ', `DROP ${accountName} ${password}`);
    }));
  }

  // ---- Stubs until later steps migrate the other operations --------

  // Same wire shape as Anope/Ergo. See account-service-helpers.ts
  // for the per-package reply phrasings the runner handles.
  async register(password: string, email: string): Promise<RegisterResult> {
    return this.guard.dedupe('register', () =>
      runRegister(this.session, this.opts.myNick, password, email, this.opts.timeoutMs),
    );
  }

  // Atheme's IDENTIFY is the same shape as Anope/Ergo. The shared
  // runIdentify helper owns the dispatch + reply classification.
  async identify(password: string): Promise<IdentifyResult> {
    return this.guard.dedupe('identify', () =>
      runIdentify(this.session, this.opts.myNick, password, this.opts.timeoutMs),
    );
  }

  // Atheme uses `VERIFY REGISTER <acct> <code>` — the literal
  // `REGISTER` is an operation keyword that distinguishes this
  // from `VERIFY EMAIL` (email-change verification, different
  // flow). Account name is required.
  //
  // Falls back to `VERIFY REGISTER <code>` when no account name
  // is supplied; older Atheme builds tolerate that and infer from
  // session, but the documented form is the 3-arg.
  async confirm(accountName: string, code: string): Promise<ConfirmResult> {
    const acct = accountName.trim();
    const cmd = acct ? `VERIFY REGISTER ${acct} ${code}` : `VERIFY REGISTER ${code}`;
    return this.guard.dedupe('confirm', () =>
      runConfirm(this.session, this.opts.myNick, cmd, this.opts.timeoutMs),
    );
  }

  async info(_accountName: string): Promise<AccountInfo> {
    throw new Error('AthemeAccountService.info not yet migrated (Step 8)');
  }

  // Atheme has NO resend command upstream (`nickserv/register.c`
  // explicitly tells the user to DROP + re-REGISTER if the email
  // didn't arrive). The UI uses this to hide the Resend button.
  supportsResend(): boolean {
    return false;
  }

  async resend(_accountName: string): Promise<ResendResult | UnsupportedResult> {
    return { kind: 'unsupported', verb: 'resend' };
  }

  // ---- Status observable (same shape as AnopeAccountService) -------

  status(): AccountStatus | undefined {
    return this.currentStatus;
  }

  onStatusChange(fn: (s: AccountStatus | undefined) => void): () => void {
    this.statusListeners.add(fn);
    try { fn(this.currentStatus); } catch { /* isolate */ }
    return () => { this.statusListeners.delete(fn); };
  }

  _setStatus(next: AccountStatus | undefined): void {
    if (this.currentStatus === next) return;
    this.currentStatus = next;
    for (const fn of this.statusListeners) {
      try { fn(next); } catch { /* isolate */ }
    }
  }

  _setMyNick(nick: string): void {
    this.opts.myNick = nick;
  }

  dispose(): void {
    this.statusListeners.clear();
  }
}
