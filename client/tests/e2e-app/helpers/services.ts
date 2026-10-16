// IRC-services helpers for the real-app e2e suite (services*.spec.ts).
//
// The e2e ergo runs its built-in NickServ with email verification: codes
// are mailed to the catch-all Mailpit (STACK.catchallMail), which the
// backend's nick-claim POP3 worker drains every 5s — it deletes anything it
// can't route to a claim, i.e. every guest / raw-peer REGISTER mail. So
// `verificationCode()` reads the undrained copy the catch-all relays to
// mailpit-archive instead. Ergo has no MemoServ (and no ChanServ channel
// registration / GHOST in this config) — see MemoNet below.
import { createServer, type Server, type Socket } from 'node:net';
import { expect, type Locator, type Page } from '@playwright/test';
import { IrcPeer, parseLine, type IrcLine } from '../irc-peer';
import { Mailpit } from './mailpit';
import { IRC_HOST, IRC_PORT, addServerManually, continueAsGuest, serverCard, uid } from '../fixtures';

const nickOf = (l: IrcLine): string => l.prefix.split('!')[0] ?? '';

// Ergo's verification mail: "Verification code: <26 lowercase alnum>".
const CODE_RE = /Verification code:\s*([a-z0-9]+)/i;

// The NickServ code ergo mailed to `email`, read from the catch-all's
// undrained copy. (Reading the catch-all itself raced the worker's drain:
// a code read more than a moment after it landed could already be gone.)
export async function verificationCode(email: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const mail = await codeMailbox();
  while (Date.now() < deadline) {
    const hit = (await mail.list(`to:"${email}"`))[0];
    if (hit) {
      const msg = await mail.read(hit.ID).catch(() => null); // may be drained between list + read
      const m = msg && CODE_RE.exec(msg.Text ?? '');
      if (m) return m[1]!;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no NickServ verification mail for ${email} within ${timeoutMs}ms`);
}

// The copy, or — on a stack brought up before mailpit-archive existed — the
// drained catch-all (racy; `e2e-stack.mjs up` again to get the copy).
let mailbox: Promise<Mailpit> | null = null;
function codeMailbox(): Promise<Mailpit> {
  mailbox ??= (async () => {
    const copy = Mailpit.catchallCopy();
    if (await copy.reachable()) return copy;
    console.warn(`[e2e] no catch-all copy at ${copy.baseUrl}: reading NickServ codes from the drained catch-all`);
    return Mailpit.catchall();
  })();
  return mailbox;
}

// Waits for a NOTICE from NickServ to the peer whose text matches `re`.
export function waitForNickServ(peer: IrcPeer, re: RegExp, from = peer.mark(), timeoutMs = 15_000): Promise<IrcLine> {
  return peer.waitFor(
    (l) => l.command === 'NOTICE' && nickOf(l).toLowerCase() === 'nickserv' && re.test(l.params[1] ?? ''),
    timeoutMs, `NickServ NOTICE ${re}`, from,
  );
}

// REGISTER + VERIFY the peer's current nick as an ergo account (ergo logs
// the peer in on VERIFY). Returns the email it was registered with.
export async function registerPeerAccount(peer: IrcPeer, password: string): Promise<string> {
  const email = `${peer.nick.toLowerCase()}@example.test`;
  const mark = peer.mark();
  peer.privmsg('NickServ', `REGISTER ${password} ${email}`);
  await waitForNickServ(peer, /pending verification/i, mark);
  const code = await verificationCode(email);
  const vmark = peer.mark();
  peer.privmsg('NickServ', `VERIFY ${peer.nick} ${code}`);
  await waitForNickServ(peer, /now logged in as/i, vmark);
  return email;
}

// Registers + verifies `nick` from a throwaway connection, then quits, so the
// app can take the nick afterwards.
export async function preregisterAccount(nick: string, password: string): Promise<void> {
  const p = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick });
  try {
    await registerPeerAccount(p, password);
  } finally {
    await p.quit();
  }
}

// `NickServ INFO <account>` from the peer → the reply lines (until the
// trailing "registered channel(s)" line, or the "does not exist" / "Name
// reserved due to a prior registration" (unregistered) error).
export async function nickServInfo(peer: IrcPeer, account: string): Promise<string[]> {
  const mark = peer.mark();
  peer.privmsg('NickServ', `INFO ${account}`);
  await waitForNickServ(peer, /registered channel\(s\)|does not exist|name reserved/i, mark);
  return peer.lines.slice(mark)
    .filter((l) => l.command === 'NOTICE' && nickOf(l).toLowerCase() === 'nickserv')
    .map((l) => l.params[1] ?? '');
}

// WHOIS `nick` from the peer → the services account it is logged into
// (RPL_WHOISACCOUNT 330), or null when it isn't logged in.
export async function whoisAccount(peer: IrcPeer, nick: string): Promise<string | null> {
  const mark = peer.mark();
  peer.send(`WHOIS ${nick}`);
  const end = await peer.waitFor(
    (l) => (l.command === '318' || l.command === '401') && (l.params[1] ?? '').toLowerCase() === nick.toLowerCase(),
    15_000, `end of WHOIS ${nick}`, mark,
  );
  if (end.command === '401') return null;
  const acct = peer.lines.slice(mark).find((l) => l.command === '330');
  return acct ? acct.params[2] ?? null : null;
}

// Polls whoisAccount until it equals `want`.
export async function expectWhoisAccount(peer: IrcPeer, nick: string, want: string | null, timeoutMs = 20_000): Promise<void> {
  await expect.poll(() => whoisAccount(peer, nick), { timeout: timeoutMs, intervals: [250, 500, 1000] }).toBe(want);
}

// ---- App UI ----------------------------------------------------------------

// Guest → add the e2e ergo (or another server) by hand → Connect → wait for
// "connected". Returns the display name.
export async function guestOnErgo(
  page: Page, nick: string,
  server: { host: string; port: number; name?: string } = { host: IRC_HOST, port: IRC_PORT },
): Promise<string> {
  const name = server.name ?? `Svc Ergo ${uid(4)}`;
  await continueAsGuest(page, nick);
  await addServerManually(page, { hostname: server.host, port: server.port, name, tls: false });
  await serverCard(page, name).getByRole('button', { name: 'Connect' }).click();
  await expectConnected(page);
  return name;
}

export async function expectConnected(page: Page, timeout = 30_000): Promise<void> {
  await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout });
}

// Channel sidebar gear → full-page Server settings → the given section.
export async function openServerSettings(page: Page, section: 'Info' | 'Identity' | 'Advanced' | 'Operators' | 'Actions' | 'Log' = 'Identity'): Promise<Locator> {
  await page.getByRole('button', { name: 'Server details' }).click();
  const settings = page.locator('main.server-settings');
  await expect(settings).toBeVisible();
  await settings.getByRole('tab', { name: new RegExp(`^${section}`) }).click();
  return settings;
}

export function closeServerSettings(page: Page): Promise<void> {
  return page.getByRole('button', { name: 'Close settings' }).click();
}

// The "Services" / "Account" badges at the top of the Identity section.
function statusRow(settings: Locator, label: string): Locator {
  return settings.locator('.services-creds-status-row .server-settings-row')
    .filter({ has: settings.page().locator('dt', { hasText: new RegExp(`^${label}$`) }) })
    .locator('dd');
}
export const servicesBadge = (settings: Locator): Locator => statusRow(settings, 'Services');
export const accountBadge = (settings: Locator): Locator => statusRow(settings, 'Account');

// ---- Mini IRC server with an Anope-style MemoServ ---------------------------
//
// Ergo ships no MemoServ and refuses `*Serv` nicks to clients (432), so a peer
// can't stand in for one. MemoNet is a minimal IRC server, run in the test
// process on a random loopback port, that registers clients, answers PING
// and plays Anope's services: NickServ VERSION carries the Anope brand (the
// engine's services probe) and MemoServ answers LIST / READ / DEL with
// Anope's wire format (what the app's memo parser was built from). The app
// connects to it as a manually added server.

export interface FakeMemo { from: string; date: string; text: string; unread: boolean }

export class MemoNet {
  readonly host = '127.0.0.1';
  private readonly clients = new Map<string, Socket>(); // lower(nick) → socket
  // Every MemoServ command received, in order ("LIST", "READ 1", …).
  readonly memoCommands: string[] = [];
  private readonly waiters: Array<{ re: RegExp; resolve: () => void }> = [];

  private constructor(private readonly server: Server, readonly port: number, private readonly memos: FakeMemo[]) {}

  static async start(memos: FakeMemo[]): Promise<MemoNet> {
    let net!: MemoNet;
    const server = createServer((sock) => net.accept(sock));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    net = new MemoNet(server, typeof addr === 'object' && addr ? addr.port : 0, memos);
    return net;
  }

  private accept(sock: Socket): void {
    sock.setEncoding('utf8');
    let buf = '';
    let nick = '';
    let user = false;
    let welcomed = false;
    const send = (line: string): void => { if (!sock.destroyed) sock.write(`${line}\r\n`); };
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const raw = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!raw) continue;
        const l = parseLine(raw);
        switch (l.command) {
          case 'CAP':
            if (l.params[0] === 'LS') send(':memo.net CAP * LS :');
            else if (l.params[0] === 'REQ') send(`:memo.net CAP * NAK :${l.params[1] ?? ''}`);
            break;
          case 'NICK': nick = l.params[0] ?? ''; break;
          case 'USER': user = true; break;
          case 'PING': send(`:memo.net PONG memo.net :${l.params[0] ?? ''}`); break;
          case 'QUIT': sock.end(); break;
          case 'PRIVMSG': {
            const target = (l.params[0] ?? '').toLowerCase();
            const text = (l.params[1] ?? '').trim();
            if (target === 'memoserv') this.memoServ(nick, text, send);
            else if (/^version$/i.test(text) && /^(nickserv|chanserv|hostserv)$/.test(target)) {
              send(`:${l.params[0]}!services@memo.net NOTICE ${nick} :Anope-2.0.14 memo.net -- build #1`);
            }
            break;
          }
          default: break; // everything else (MODE, LIST, WHO, …) is ignored
        }
        if (!welcomed && nick && user) {
          welcomed = true;
          this.clients.set(nick.toLowerCase(), sock);
          send(`:memo.net 001 ${nick} :Welcome to MemoNet ${nick}`);
          send(`:memo.net 002 ${nick} :Your host is memo.net, running version memonet-1`);
          send(`:memo.net 003 ${nick} :This server was created today`);
          send(`:memo.net 004 ${nick} memo.net memonet-1 i nt`);
          send(`:memo.net 005 ${nick} NETWORK=MemoNet CHANTYPES=# CASEMAPPING=ascii :are supported by this server`);
          send(`:memo.net 422 ${nick} :MOTD File is missing`);
        }
      }
    });
    sock.on('close', () => { if (nick) this.clients.delete(nick.toLowerCase()); });
    sock.on('error', () => {});
  }

  // Resolves once `nick` has registered.
  async waitForClient(nick: string, timeoutMs = 30_000): Promise<void> {
    await expect.poll(() => this.clients.has(nick.toLowerCase()), { timeout: timeoutMs }).toBe(true);
  }

  waitForCommand(re: RegExp, timeoutMs = 15_000): Promise<void> {
    if (this.memoCommands.some((c) => re.test(c))) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`MemoServ never got ${re}; got ${JSON.stringify(this.memoCommands)}`)), timeoutMs);
      this.waiters.push({ re, resolve: () => { clearTimeout(t); resolve(); } });
    });
  }

  // What Anope sends on identify: "You have N new memo(s)."
  announce(nick: string): void {
    const n = this.memos.filter((m) => m.unread).length;
    this.notice(nick, n === 0 ? 'You have no memos.' : `You have ${n} new memo${n === 1 ? '' : 's'}.`);
  }

  private notice(nick: string, text: string): void {
    const sock = this.clients.get(nick.toLowerCase());
    if (sock && !sock.destroyed) sock.write(`:MemoServ!services@memo.net NOTICE ${nick} :${text}\r\n`);
  }

  private memoServ(from: string, cmd: string, _send: (l: string) => void): void {
    this.memoCommands.push(cmd);
    for (const w of this.waiters.splice(0)) {
      if (w.re.test(cmd)) w.resolve(); else this.waiters.push(w);
    }
    const [verb = '', arg = ''] = cmd.split(/\s+/);
    const say = (t: string): void => this.notice(from, t);
    switch (verb.toUpperCase()) {
      case 'LIST':
        if (this.memos.length === 0) { say('You have no memos.'); return; }
        say(`Memos for ${from}:`);
        say(' Number  Sender  Date/Time');
        this.memos.forEach((m, i) => say(`${m.unread ? '*' : ' '} ${i + 1}     ${m.from}  ${m.date} (3 minutes ago)`));
        return;
      case 'READ': {
        const i = Number(arg) - 1;
        const m = this.memos[i];
        if (!m) { say(`Memo ${arg} doesn't exist!`); return; }
        m.unread = false;
        say(`Memo ${i + 1} from ${m.from} (${m.date} (3 minutes ago)).`);
        say(m.text);
        say(`To delete, type: /msg MemoServ DEL ${i + 1}`);
        return;
      }
      case 'DEL': {
        if (arg.toUpperCase() === 'ALL') { this.memos.splice(0); say('All of your memos have been deleted.'); return; }
        const i = Number(arg) - 1;
        if (!this.memos[i]) { say(`Memo ${arg} doesn't exist!`); return; }
        this.memos.splice(i, 1);
        say(`Memo ${i + 1} has been deleted.`);
        return;
      }
      default:
        say(`Unknown command ${verb}. "/msg MemoServ HELP" for help.`);
    }
  }

  async stop(): Promise<void> {
    for (const s of this.clients.values()) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
