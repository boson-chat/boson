// Minimal raw-socket IRC client used as the "other side" of a conversation
// in the real-app e2e suite: it registers on the test ergo, joins channels,
// sends PRIVMSGs and lets a spec wait for lines the app produced. Also used
// to talk to ZNC's *status for test setup.
//
// Deliberately tiny and dependency-free — just enough IRC to be a peer.
import { createConnection, type Socket } from 'node:net';

export interface IrcLine {
  raw: string;
  // IRCv3 message tags (only when the peer negotiated message-tags).
  tags: Record<string, string>;
  prefix: string;
  command: string;
  params: string[];
}

export function parseLine(raw: string): IrcLine {
  let rest = raw;
  // IRCv3 message tags (sent when the peer requested caps, and by ZNC/ergo
  // on some replies regardless).
  const tags: Record<string, string> = {};
  if (rest.startsWith('@')) {
    for (const kv of rest.slice(1, rest.indexOf(' ')).split(';')) {
      const eq = kv.indexOf('=');
      tags[eq < 0 ? kv : kv.slice(0, eq)] = eq < 0 ? '' : kv.slice(eq + 1);
    }
    rest = rest.slice(rest.indexOf(' ') + 1);
  }
  let prefix = '';
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  const params: string[] = [];
  while (rest.length > 0) {
    if (rest.startsWith(':')) {
      params.push(rest.slice(1));
      break;
    }
    const sp = rest.indexOf(' ');
    if (sp === -1) {
      params.push(rest);
      break;
    }
    params.push(rest.slice(0, sp));
    rest = rest.slice(sp + 1);
  }
  const command = (params.shift() ?? '').toUpperCase();
  return { raw, tags, prefix, command, params };
}

type Matcher = (l: IrcLine) => boolean;

export class IrcPeer {
  readonly lines: IrcLine[] = [];
  private socket: Socket | null = null;
  private buf = '';
  private waiters: Array<{ match: Matcher; from: number; resolve: (l: IrcLine) => void }> = [];

  private constructor(readonly nick: string) {}

  // Connects and completes registration (waits for 001). `pass` is sent as
  // PASS before NICK/USER — for ZNC that's `user/network:password`.
  static async connect(opts: {
    host: string;
    port: number;
    nick: string;
    pass?: string;
    // IRCv3 caps to request during registration (e.g. message-tags to send
    // +typing TAGMSGs). Registration waits for the ACK/NAK.
    caps?: string[];
    timeoutMs?: number;
  }): Promise<IrcPeer> {
    const peer = new IrcPeer(opts.nick);
    await peer.open(opts.host, opts.port);
    if (opts.caps?.length) peer.send('CAP LS 302');
    if (opts.pass) peer.send(`PASS ${opts.pass}`);
    peer.send(`NICK ${opts.nick}`);
    peer.send(`USER ${opts.nick} 0 * :boson e2e peer`);
    if (opts.caps?.length) {
      peer.send(`CAP REQ :${opts.caps.join(' ')}`);
      await peer.waitFor((l) => l.command === 'CAP' && (l.params[1] === 'ACK' || l.params[1] === 'NAK'), opts.timeoutMs ?? 15_000, 'CAP ACK');
      peer.send('CAP END');
    }
    await peer.waitFor((l) => l.command === '001', opts.timeoutMs ?? 15_000, 'RPL_WELCOME');
    return peer;
  }

  private open(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = createConnection({ host, port });
      s.setEncoding('utf8');
      s.once('connect', () => resolve());
      s.once('error', reject);
      s.on('data', (chunk: string) => this.onData(chunk));
      this.socket = s;
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const raw = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      if (!raw) continue;
      const line = parseLine(raw);
      if (line.command === 'PING') {
        this.send(`PONG :${line.params[0] ?? ''}`);
      }
      this.lines.push(line);
      const idx = this.lines.length - 1;
      this.waiters = this.waiters.filter((w) => {
        if (idx >= w.from && w.match(line)) {
          w.resolve(line);
          return false;
        }
        return true;
      });
    }
  }

  send(line: string): void {
    this.socket?.write(`${line}\r\n`);
  }

  // Resolves with the first line (already received at index >= `from`, or
  // arriving later) that satisfies `match`. `from` defaults to 0 so a line
  // that raced ahead of the call is never missed; pass `peer.mark()` to only
  // consider lines after a point in time.
  waitFor(match: Matcher, timeoutMs = 15_000, what = 'line', from = 0): Promise<IrcLine> {
    const hit = this.lines.slice(from).find(match);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const waiter = { match, from, resolve: (l: IrcLine) => { clearTimeout(timer); resolve(l); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        const tail = this.lines.slice(-15).map((l) => `  ${l.raw}`).join('\n');
        reject(new Error(`[irc-peer ${this.nick}] timed out after ${timeoutMs}ms waiting for ${what}. Last lines:\n${tail}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  mark(): number {
    return this.lines.length;
  }

  async join(channel: string): Promise<void> {
    const from = this.mark();
    this.send(`JOIN ${channel}`);
    await this.waitFor(
      (l) => l.command === '366' && (l.params[1] ?? '').toLowerCase() === channel.toLowerCase(),
      15_000,
      `end of NAMES for ${channel}`,
      from,
    );
  }

  privmsg(target: string, text: string): void {
    this.send(`PRIVMSG ${target} :${text}`);
  }

  // Waits for a PRIVMSG to `target` containing `text`, from any sender.
  waitForPrivmsg(target: string, text: string, timeoutMs = 15_000): Promise<IrcLine> {
    return this.waitFor(
      (l) =>
        l.command === 'PRIVMSG' &&
        (l.params[0] ?? '').toLowerCase() === target.toLowerCase() &&
        (l.params[1] ?? '').includes(text),
      timeoutMs,
      `PRIVMSG ${target} containing "${text}"`,
    );
  }

  // Waits until `nick` is in `channel` (JOIN seen, or present in NAMES).
  waitForJoin(channel: string, nick: string, timeoutMs = 15_000): Promise<IrcLine> {
    const lc = nick.toLowerCase();
    return this.waitFor(
      (l) =>
        l.command === 'JOIN' &&
        l.prefix.split('!')[0]!.toLowerCase() === lc &&
        (l.params[0] ?? '').toLowerCase() === channel.toLowerCase(),
      timeoutMs,
      `${nick} joining ${channel}`,
    );
  }

  // WHOIS `nick` as the network sees it: whether it's online, and the
  // channels it's in (RPL_WHOISCHANNELS, status prefixes stripped,
  // lowercased).
  async whois(nick: string, timeoutMs = 15_000): Promise<{ online: boolean; channels: string[] }> {
    const from = this.mark();
    const lc = nick.toLowerCase();
    const about = (l: IrcLine): boolean => (l.params[1] ?? '').toLowerCase() === lc;
    this.send(`WHOIS ${nick}`);
    await this.waitFor((l) => l.command === '318' && about(l), timeoutMs, `end of WHOIS ${nick}`, from);
    const replies = this.lines.slice(from).filter(about);
    return {
      online: replies.some((l) => l.command === '311') && !replies.some((l) => l.command === '401'),
      channels: replies
        .filter((l) => l.command === '319')
        .flatMap((l) => (l.params[2] ?? '').split(' '))
        .filter(Boolean)
        .map((c) => c.replace(/^[~&@%+]+/, '').toLowerCase()),
    };
  }

  // The nicks in `channel` per NAMES (status prefixes stripped, lowercased).
  async names(channel: string, timeoutMs = 15_000): Promise<string[]> {
    const from = this.mark();
    const lc = channel.toLowerCase();
    this.send(`NAMES ${channel}`);
    await this.waitFor(
      (l) => l.command === '366' && (l.params[1] ?? '').toLowerCase() === lc,
      timeoutMs, `end of NAMES ${channel}`, from,
    );
    return this.lines.slice(from)
      .filter((l) => l.command === '353' && (l.params[2] ?? '').toLowerCase() === lc)
      .flatMap((l) => (l.params[3] ?? '').split(' '))
      .filter(Boolean)
      .map((n) => n.replace(/^[~&@%+]+/, '').split('!')[0]!.toLowerCase());
  }

  async quit(msg = 'bye'): Promise<void> {
    const s = this.socket;
    if (!s || s.destroyed) return;
    this.send(`QUIT :${msg}`);
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { s.destroy(); resolve(); }, 1_000);
      s.once('close', () => { clearTimeout(t); resolve(); });
      s.end();
    });
    this.socket = null;
  }
}
