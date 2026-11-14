// Runs ChanServ operations over a plain IRC session: PRIVMSG the service,
// collect its NOTICEs, and let the operation's classifier decide.
//
// Services replies carry no correlation id, so operations run one at a time
// per connection (a queue), and an operation "owns" every NOTICE from the
// service while it runs. It ends on the classifier's verdict, or when the
// service has been quiet for `quietMs` after its last line (multi-line
// replies like INFO have no reliable terminator on every package), or after
// `timeoutMs` with no reply at all.
import type { IrcEvent } from '../engine/engine.types';
import type { ChanServError, Operation } from './chanserv.types';
import { err, sameName } from './text';

export interface RunnerSession {
  privmsg(target: string, message: string): void;
  onEvent(fn: (e: IrcEvent) => void): () => void;
}

export interface RunnerOptions {
  quietMs?: number;
  timeoutMs?: number;
}

const QUIET_MS = 700;
const TIMEOUT_MS = 10_000;

export class ChanServRunner {
  private tail: Promise<unknown> = Promise.resolve();
  private activeNick: string | null = null;
  // Replies an operation consumed (kept after it ends, so the line that
  // ended it is still recognised by later listeners of the same event).
  private readonly claimed = new WeakSet<IrcEvent>();
  private readonly quietMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly session: RunnerSession, opts: RunnerOptions = {}) {
    this.quietMs = opts.quietMs ?? QUIET_MS;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  // Is this event a reply an operation in flight is consuming? The chat
  // service uses it to keep background lookups out of the Server log.
  claims(e: IrcEvent): boolean {
    return this.claimed.has(e) || this.isReply(e);
  }

  private isReply(e: IrcEvent): boolean {
    return this.activeNick !== null && (e.Kind === 'NOTICE' || e.Kind === 'PRIVMSG') && sameName(e.From, this.activeNick);
  }

  get busy(): boolean { return this.activeNick !== null; }

  // Resolves once every queued operation has finished.
  async idle(): Promise<void> {
    let seen: Promise<unknown>;
    do {
      seen = this.tail;
      await seen;
    } while (seen !== this.tail);
  }

  run<T>(serviceNick: string, op: Operation<T>): Promise<T | ChanServError> {
    const next = this.tail.then(() => this.exec(serviceNick, op), () => this.exec(serviceNick, op));
    this.tail = next.catch(() => {});
    return next;
  }

  private exec<T>(serviceNick: string, op: Operation<T>): Promise<T | ChanServError> {
    if (!op.first) {
      const v = op.step([], true);
      return Promise.resolve(v && 'final' in v ? v.final : err('unsupported', []));
    }
    return new Promise((resolve) => {
      let lines: string[] = [];
      let followUps = 0;
      let quiet: ReturnType<typeof setTimeout> | undefined;
      let overall: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      let unsubscribe: () => void = () => {};

      const finish = (r: T | ChanServError): void => {
        if (finished) return;
        finished = true;
        if (quiet) clearTimeout(quiet);
        if (overall) clearTimeout(overall);
        unsubscribe();
        this.activeNick = null;
        resolve(r);
      };
      const armOverall = (): void => {
        if (overall) clearTimeout(overall);
        overall = setTimeout(() => {
          if (lines.length) decide(true);
          else finish(err('timeout', []));
        }, this.timeoutMs);
      };
      const send = (body: string): void => {
        lines = [];
        armOverall();
        this.session.privmsg(serviceNick, body);
      };
      const decide = (settled: boolean): void => {
        let v;
        try {
          v = op.step(lines, settled);
        } catch {
          v = { final: err('unreadable', lines) as T | ChanServError };
        }
        if (!v) {
          if (settled) finish(err('unreadable', lines));
          return;
        }
        if ('final' in v) { finish(v.final); return; }
        if (followUps >= (op.maxFollowUps ?? 2)) { finish(err('unreadable', lines)); return; }
        followUps++;
        if (quiet) clearTimeout(quiet);
        send(v.send);
      };

      this.activeNick = serviceNick;
      unsubscribe = this.session.onEvent((e) => {
        if (finished) return;
        // No such service (401 ERR_NOSUCHNICK) or services down (440).
        if ((e.Kind === '401' && sameName(e.Args?.[0], serviceNick)) || e.Kind === '440') {
          finish(err('no-service', lines));
          return;
        }
        if (!this.isReply(e)) return;
        // A service only ever messages us, never a channel.
        if (e.Target && (e.Target.startsWith('#') || e.Target.startsWith('&'))) return;
        this.claimed.add(e);
        lines.push(e.Message ?? '');
        if (quiet) clearTimeout(quiet);
        quiet = setTimeout(() => decide(true), this.quietMs);
        decide(false);
      });
      send(op.first);
    });
  }
}
