// ErgoAccountService — the Ergo IRCd implementation of the
// AccountService interface.
//
// Ergo (formerly Oragono) ships built-in services rather than a
// separate Atheme/Anope process. Differences from those two:
//   - Deletion verb is UNREGISTER, not DROP.
//   - Two-step token-based confirm (similar shape to Atheme's KEY
//     replay, but the token slot is filled differently).
//   - Many replies use the `/NS` shorthand instead of the long
//     `/msg NickServ` form — the shared inline-command extractor
//     accepts both.
//
// Captured live (`ghcr.io/ergochat/ergo:stable`, May 2026):
//
//   client > UNREGISTER e2edrop465933303
//   server > Warning: unregistering this account will remove ...
//   server > If you are having problems with your account ...
//   server > Unregistering your account will unregister all channels ...
//   server > Note that an unregistered account name remains reserved ...
//   server > To prevent this, transfer your channels first with CS TRANSFER.
//   server > To confirm, run this command: /NS UNREGISTER e2edrop465933303 xjzda
//   client > UNREGISTER e2edrop465933303 xjzda
//   server > Successfully unregistered account e2edrop465933303
//
// All warning NOTICEs are informational — they shouldn't resolve
// the operation. Only the final "To confirm, run this command"
// prompt triggers the replay; the terminal "Successfully
// unregistered" closes the operation.

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

export interface ErgoAccountServiceOpts {
  myNick: string;
  timeoutMs?: number;
}

export class ErgoAccountService implements AccountService {
  readonly framework = 'ergo' as const;

  private readonly session: ServerSession;
  private readonly opts: Required<ErgoAccountServiceOpts>;
  private readonly statusListeners = new Set<(s: AccountStatus | undefined) => void>();
  private currentStatus: AccountStatus | undefined;
  // Defense-in-depth against double-fire; see OperationGuard.
  private readonly guard = new OperationGuard();

  constructor(session: ServerSession, opts: ErgoAccountServiceOpts) {
    this.session = session;
    this.opts = {
      myNick: opts.myNick,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  // ---- drop() — UNREGISTER + token replay --------------------------
  //
  // Password is accepted in the signature for symmetry with the
  // other impls but Ergo's UNREGISTER doesn't need it — the
  // already-identified session is the auth. We don't put it on the
  // wire.
  async drop(accountName: string, _password: string): Promise<DropResult> {
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

        // Token replay step. Server says "To confirm, run this
        // command: /NS UNREGISTER <acct> <token>". Echo verbatim.
        // The shared helper anchors strictly enough that the warning
        // notices ("Warning: unregistering this account ...") don't
        // false-match here.
        if (REPLAY_PHRASES.test(body)) {
          const cmd = extractInlineNickservCommand(body);
          if (cmd) {
            this.session.privmsg('NickServ', cmd);
            return;
          }
          finish({ kind: 'failed', reason: 'could-not-parse-inline-command' });
          return;
        }

        // Terminal: success. Ergo: "Successfully unregistered
        // account X" (irc/nickserv.go via SendSuccessfulRegResponse).
        if (/\bsuccessfully unregistered\b/i.test(body)) {
          finish({ kind: 'dropped' });
          return;
        }

        // Terminal: account doesn't exist.
        //   Ergo errors.go: "Authentication failed: Account does not exist"
        //   Generic "no such account" catches alternate phrasings.
        if (/\baccount does not exist\b/i.test(body) || /\bno such (?:account|nick)\b/i.test(body)) {
          finish({ kind: 'no-such-account' });
          return;
        }

        // Terminal: auth failed (rare for UNREGISTER but possible
        // when the user isn't identified or the session expired
        // mid-operation).
        if (/\bauthentication failed\b/i.test(body) || /\binvalid (?:account )?credentials\b/i.test(body)) {
          finish({ kind: 'wrong-password' });
          return;
        }
      });

      // Kick off: UNREGISTER is Ergo's deletion verb (DROP returns
      // "Unknown command" on current builds).
      this.session.privmsg('NickServ', `UNREGISTER ${accountName}`);
    }));
  }

  // ---- Stubs until later steps -------------------------------------

  // Same wire shape as Anope/Atheme. Ergo's "Account created" /
  // "Account created, pending verification" phrasings are handled
  // by the shared classifier; pending-verification takes priority.
  async register(password: string, email: string): Promise<RegisterResult> {
    return this.guard.dedupe('register', () =>
      runRegister(this.session, this.opts.myNick, password, email, this.opts.timeoutMs),
    );
  }

  // Ergo's IDENTIFY shares shape with Anope/Atheme. The shared
  // runIdentify helper owns the dispatch + reply classification.
  // (Ergo prefers SASL where available, but the imperative IDENTIFY
  // path is still supported and used for manual re-identify.)
  async identify(password: string): Promise<IdentifyResult> {
    return this.guard.dedupe('identify', () =>
      runIdentify(this.session, this.opts.myNick, password, this.opts.timeoutMs),
    );
  }

  // Ergo uses `VERIFY <acct> <code>` (no `REGISTER` operation
  // keyword — that's Atheme's distinguishing marker, not Ergo's).
  async confirm(accountName: string, code: string): Promise<ConfirmResult> {
    const acct = accountName.trim();
    const cmd = acct ? `VERIFY ${acct} ${code}` : `VERIFY ${code}`;
    return this.guard.dedupe('confirm', () =>
      runConfirm(this.session, this.opts.myNick, cmd, this.opts.timeoutMs),
    );
  }

  async info(_accountName: string): Promise<AccountInfo> {
    throw new Error('ErgoAccountService.info not yet migrated (Step 8)');
  }

  // Ergo has no upstream resend equivalent on default builds; some
  // variants expose VERIFY-RESEND but it's version-dependent.
  // Conservative default: false (UI hides the button).
  supportsResend(): boolean {
    return false;
  }

  async resend(_accountName: string): Promise<ResendResult | UnsupportedResult> {
    return { kind: 'unsupported', verb: 'resend' };
  }

  // ---- Status observable (same shape as the other impls) -----------

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
