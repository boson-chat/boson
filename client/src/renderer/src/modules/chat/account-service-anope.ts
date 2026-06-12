// AnopeAccountService — the Anope-specific implementation of the
// package-agnostic AccountService interface.
//
// First operation migrated: `drop()`. The 1-arg → maybe-2-arg-fallback
// → maybe-DROP-CONFIRM dance is owned here, not by chat.service.ts.
// The caller awaits a single Promise<DropResult> and switches on the
// kind — no classifier-kind branching at the call site.
//
// Other methods (register/identify/confirm/info/resend) currently
// resolve to `{ kind: 'failed', reason: 'not-yet-migrated' }`. Each
// gets a real impl in its own step (5–8). Until then, the existing
// legacy paths (adapters.ts + chat.service.ts) continue to handle
// those operations.

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
import { REPLAY_PHRASES, extractInlineNickservCommand, stripFormat, runIdentify, runRegister, runConfirm, runResend, runInfo, classifyInfoReply, OperationGuard } from './account-service-helpers';

// How long to wait for a terminal reply before giving up and
// resolving to { kind: 'failed', reason: 'timeout' }. Network round
// trips on a healthy Anope are sub-second; 10s is comfortable for
// the worst case (multi-step DROP CONFIRM on a laggy link).
const DEFAULT_TIMEOUT_MS = 10_000;

export interface AnopeAccountServiceOpts {
  // The current nick on this session. Used to filter NickServ
  // NOTICEs addressed to us vs broadcast notices. Passed in rather
  // than read from the session because the session doesn't expose
  // myNick (ChatService holds that state); pass the live value
  // when the AccountService is constructed.
  myNick: string;
  // Override for tests; production callers can omit.
  timeoutMs?: number;
}

export class AnopeAccountService implements AccountService {
  readonly framework = 'anope' as const;

  private readonly session: ServerSession;
  private readonly opts: Required<AnopeAccountServiceOpts>;
  private readonly statusListeners = new Set<(s: AccountStatus | undefined) => void>();
  private currentStatus: AccountStatus | undefined;
  // Dedupes concurrent calls to the same operation kind — see
  // OperationGuard's class comment for why this matters (Atheme's
  // single-key-per-drop-session is the canonical hazard).
  private readonly guard = new OperationGuard();

  constructor(session: ServerSession, opts: AnopeAccountServiceOpts) {
    this.session = session;
    this.opts = {
      myNick: opts.myNick,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  // ---- drop() — the operation this step migrates -------------------
  //
  // Walks the full Anope drop conversation:
  //
  //   1. Send `DROP <acct>` (1-arg canonical).
  //   2. If the server replies `Syntax: DROP <account> <password>`,
  //      it's a production-patched build that requires the password
  //      inline — fire `DROP <acct> <pw>` and continue.
  //   3. If the server replies with a `DROP CONFIRM` follow-up
  //      prompt (Anope's two-step variant), fire `DROP CONFIRM`.
  //   4. Wait for the terminal "has been dropped" or a failure
  //      phrasing (wrong password, isn't registered).
  //
  // Returns a discrete DropResult. Caller never sees the
  // intermediate prompts, never branches on the legacy
  // `drop-needs-password` / `drop-confirm-prompt` classifier kinds
  // (which are removed alongside this step).
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
        // We only care about NickServ NOTICEs addressed to us.
        if (e.Kind !== 'NOTICE') return;
        if (!isNickServSender(e.From)) return;
        if (e.Target !== this.opts.myNick) return;

        // Strip IRC formatting bytes (\x02 bold, \x1d italic, etc.)
        // so the regex anchors don't need to consider them. Same
        // bytes the legacy service-confirm-replay handler strips.
        const body = stripFormat(e.Message);

        // ---- Intermediate steps (fire follow-up, keep waiting) ----

        // Production-patched Anope: ns_drop requires 2 args. Server
        // tells us with "Syntax: DROP <account> <password>". Fire
        // the 2-arg form using the password we already have.
        if (/\bsyntax:\s*drop\s+<account>\s+<password>/i.test(body)) {
          this.session.privmsg('NickServ', `DROP ${accountName} ${password}`);
          return;
        }

        // Generic "please reply with this inline command" — covers:
        //   * Anope canonical: "To confirm, type: /msg NickServ DROP CONFIRM"
        //   * Anope 3-arg variant (irc.boson.chat-style with source mask):
        //     "Please confirm by replying with /msg NickServ DROP <nick>
        //      <hostmask> <token>"
        //   * Anything else the server tells us to echo verbatim.
        // Extract the inline command from the reply and fire it. The
        // shared helper anchors only on imperatives ("please confirm
        // by replying", "to confirm, type", "you must reply with",
        // "to complete... reply with") to avoid false-matching info
        // notices that just happen to mention /msg NickServ.
        if (REPLAY_PHRASES.test(body)) {
          const cmd = extractInlineNickservCommand(body);
          if (cmd) {
            this.session.privmsg('NickServ', cmd);
            return;
          }
          // Recognised the prompt but couldn't extract — give up
          // rather than hang waiting for a follow-up the server
          // expected us to fire.
          finish({ kind: 'failed', reason: 'could-not-parse-inline-command' });
          return;
        }

        // ---- Terminal outcomes ----

        // Anope drop-success: "Nickname X has been dropped." /
        // "Your account has been dropped."
        if (/\bhas been dropped\b/i.test(body)) {
          finish({ kind: 'dropped' });
          return;
        }

        // Wrong password — only reachable on the 2-arg fallback
        // path. Anope's exact phrasing is "Password incorrect."
        if (/\binvalid password\b/i.test(body) || /\bpassword incorrect\b/i.test(body)) {
          finish({ kind: 'wrong-password' });
          return;
        }

        // Nick not registered — happens when the DROP target was
        // never an account, or it was dropped between the user
        // clicking and the conversation reaching the server.
        // Anope: "Nick X isn't registered." (NICK_X_NOT_REGISTERED).
        if (/\bisn'?t registered\b/i.test(body) || /\bis not (?:a )?registered nickname\b/i.test(body)) {
          finish({ kind: 'no-such-account' });
          return;
        }
      });

      // Kick off the conversation with the 1-arg canonical form.
      this.session.privmsg('NickServ', `DROP ${accountName}`);
    }));
  }

  // ---- Stubs until later steps migrate the other operations --------
  //
  // Returning failed/unsupported here means the new accountService
  // path is unusable for these ops; callers continue using the
  // legacy adapter+classifier path. As each step lands, the stub
  // is replaced with a real impl.

  // ---- register() — same shape across all 3 packages ------------
  //
  // `REGISTER <pw> <email>` is identical on the wire. The reply
  // differs by whether email confirmation is server-configured —
  // the shared runRegister helper resolves to pending-confirmation
  // or registered accordingly.
  async register(password: string, email: string): Promise<RegisterResult> {
    return this.guard.dedupe('register', () =>
      runRegister(this.session, this.opts.myNick, password, email, this.opts.timeoutMs),
    );
  }

  // ---- identify() — same shape across all 3 packages -------------
  //
  // Anope, Atheme, and Ergo all accept `IDENTIFY <password>` and emit
  // a single terminal reply (success or failure). The shared
  // classifyIdentifyReply helper handles the union of reply
  // phrasings — see account-service-helpers.ts for the per-package
  // citations.
  //
  // The "identified-unconfirmed" state is NOT computed here — that's
  // a badge-layer concern computed from the prior status when the
  // classifier fires (see chat.service.ts maybeUpdateAccountStatus).
  // identify() resolves on the first terminal reply.
  async identify(password: string): Promise<IdentifyResult> {
    return this.guard.dedupe('identify', () =>
      runIdentify(this.session, this.opts.myNick, password, this.opts.timeoutMs),
    );
  }

  // Anope's CONFIRM doesn't include the account name — the server
  // knows from session context. Account name parameter accepted for
  // interface symmetry but ignored on the wire.
  async confirm(_accountName: string, code: string): Promise<ConfirmResult> {
    return this.guard.dedupe('confirm', () =>
      runConfirm(this.session, this.opts.myNick, `CONFIRM ${code}`, this.opts.timeoutMs),
    );
  }

  // Silent state probe: fires `INFO <nick>` and parses the multi-line
  // block into {registered, confirmed, email, …}. Used by the panel
  // on open to pick the right CTA (Claim vs Confirm vs Identify)
  // instead of optimistically firing REGISTER. Dedupes concurrent
  // probes so a fast double-open doesn't race two INFO blocks.
  async info(accountName: string): Promise<AccountInfo> {
    return this.guard.dedupe('info', () =>
      runInfo(this.session, this.opts.myNick, accountName, classifyInfoReply, {
        timeoutMs: this.opts.timeoutMs,
      }),
    );
  }

  supportsResend(): boolean {
    return true;
  }

  // Anope `RESEND` re-sends the confirmation email. accountName is
  // ignored on the wire — the bare form infers the account from the
  // source mask (the optional <nickname> arg is oper-only on most
  // builds).
  async resend(_accountName: string): Promise<ResendResult | UnsupportedResult> {
    return this.guard.dedupe('resend', () =>
      runResend(this.session, this.opts.myNick, this.opts.timeoutMs),
    );
  }

  // ---- Status observable (unchanged from today's flow) -------------
  //
  // Today the credentials store is global and ChatService writes to
  // it on classified replies. The AccountService.status() observable
  // is a thin re-export — when the refactor stabilises in Step 9 we
  // can move ownership into the service. For now it mirrors what
  // the panel already reads.

  status(): AccountStatus | undefined {
    return this.currentStatus;
  }

  onStatusChange(fn: (s: AccountStatus | undefined) => void): () => void {
    this.statusListeners.add(fn);
    // Sync replay so subscribers don't have to special-case mount.
    try { fn(this.currentStatus); } catch { /* isolate */ }
    return () => { this.statusListeners.delete(fn); };
  }

  // Internal hook (called by ChatService when it observes a classified
  // status change). Not part of the AccountService interface — just a
  // way for the existing maybeUpdateAccountStatus path to forward
  // updates until Step 9 moves ownership entirely.
  _setStatus(next: AccountStatus | undefined): void {
    if (this.currentStatus === next) return;
    this.currentStatus = next;
    for (const fn of this.statusListeners) {
      try { fn(next); } catch { /* isolate */ }
    }
  }

  // Sync the live nick when ChatService observes a NICK change. The
  // DROP conversation depends on `Target === myNick` matching.
  _setMyNick(nick: string): void {
    this.opts.myNick = nick;
  }

  dispose(): void {
    this.statusListeners.clear();
  }
}

