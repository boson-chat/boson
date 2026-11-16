// A proxy between the app and the e2e ergo that adds IRCv3 chathistory
// (the e2e ergo runs with history off): it offers the `chathistory` cap,
// ACKs it when the app asks, and answers CHATHISTORY LATEST / BEFORE
// itself, from a scripted backlog per channel. Everything else is ergo's.
import { createConnection, createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { IRC_HOST, IRC_PORT } from '../fixtures';

export interface HistoryLine {
  /** Unix ms. */
  time: number;
  from: string;
  text: string;
}

export interface HistoryProxy {
  port: number;
  /** Set a channel's backlog (any order). */
  setHistory(channel: string, lines: HistoryLine[]): void;
  /** Leave CHATHISTORY BEFORE unanswered (a server that went quiet). */
  stallBefore: boolean;
  /** The CHATHISTORY commands the app sent, in order. */
  readonly requests: string[];
  close(): Promise<void>;
}

const CAP = 'chathistory';

// Splits a socket's bytes into IRC lines (without the CRLF).
function lines(sock: Socket, onLine: (line: string) => void): void {
  let buf = '';
  sock.on('data', (b: Buffer) => {
    buf += b.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      onLine(line);
    }
  });
}

// "@tags :prefix CMD a b :trailing" → its command and params.
function parse(line: string): { command: string; params: string[] } {
  let rest = line;
  if (rest.startsWith('@')) rest = rest.slice(rest.indexOf(' ') + 1);
  if (rest.startsWith(':')) rest = rest.slice(rest.indexOf(' ') + 1);
  const params: string[] = [];
  while (rest.length > 0) {
    if (rest.startsWith(':')) { params.push(rest.slice(1)); break; }
    const sp = rest.indexOf(' ');
    if (sp < 0) { params.push(rest); break; }
    params.push(rest.slice(0, sp));
    rest = rest.slice(sp + 1).replace(/^ +/, '');
  }
  return { command: (params.shift() ?? '').toUpperCase(), params };
}

export async function startHistoryProxy(): Promise<HistoryProxy> {
  const history = new Map<string, HistoryLine[]>();
  const live = new Set<Socket>();
  const requests: string[] = [];
  let batchSeq = 0;
  const proxy: HistoryProxy = {
    port: 0,
    stallBefore: false,
    setHistory: (channel, ls) => { history.set(channel.toLowerCase(), ls); },
    requests,
    close: () => new Promise<void>((resolve) => {
      for (const s of live) s.destroy();
      live.clear();
      server.close(() => resolve());
    }),
  };

  const server = createServer((client) => {
    const upstream = createConnection({ host: IRC_HOST, port: IRC_PORT });
    live.add(client);
    live.add(upstream);
    const end = (): void => { client.destroy(); upstream.destroy(); live.delete(client); live.delete(upstream); };
    client.on('error', end).on('close', end);
    upstream.on('error', end).on('close', end);
    const toClient = (l: string): void => { if (!client.destroyed) client.write(`${l}\r\n`); };
    const toUpstream = (l: string): void => { if (!upstream.destroyed) upstream.write(`${l}\r\n`); };
    let wantsCap = false;
    let nick = '*';

    const answer = (params: string[]): void => {
      const [sub = '', target = '', ref = '', limitArg = '50'] = params;
      const limit = Math.max(1, Number(limitArg) || 50);
      const all = [...(history.get(target.toLowerCase()) ?? [])].sort((a, b) => a.time - b.time);
      let page: HistoryLine[] = [];
      if (sub.toUpperCase() === 'LATEST') {
        page = all.slice(-limit);
      } else if (sub.toUpperCase() === 'BEFORE') {
        const ts = ref.startsWith('timestamp=') ? Date.parse(ref.slice('timestamp='.length)) : NaN;
        const before = Number.isNaN(ts) ? all : all.filter((l) => l.time < ts);
        page = before.slice(-limit);
      }
      const id = `h${++batchSeq}`;
      toClient(`:proxy.history BATCH +${id} chathistory ${target}`);
      for (const l of page) {
        toClient(`@batch=${id};time=${new Date(l.time).toISOString()};msgid=hp-${l.time}-${l.from} :${l.from}!h@history.test PRIVMSG ${target} :${l.text}`);
      }
      toClient(`:proxy.history BATCH -${id}`);
    };

    lines(client, (line) => {
      const { command, params } = parse(line);
      if (command === 'NICK' && params[0]) nick = params[0];
      if (command === 'CAP' && (params[0] ?? '').toUpperCase() === 'REQ') {
        const caps = (params[params.length - 1] ?? '').split(' ').filter(Boolean);
        if (caps.includes(CAP)) {
          wantsCap = true;
          const rest = caps.filter((c) => c !== CAP);
          if (rest.length === 0) { toClient(`:proxy.history CAP ${nick} ACK :${CAP}`); return; }
          toUpstream(`CAP REQ :${rest.join(' ')}`);
          return;
        }
      }
      if (command === 'CHATHISTORY') {
        requests.push(line);
        if (proxy.stallBefore && (params[0] ?? '').toUpperCase() === 'BEFORE') return;
        answer(params);
        return;
      }
      toUpstream(line);
    });

    lines(upstream, (line) => {
      const { command, params } = parse(line);
      if (command === 'CAP') {
        const sub = (params[1] ?? '').toUpperCase();
        // The last line of the LS (a continued one has "*" before the list).
        if (sub === 'LS' && params[2] !== '*') { toClient(`${line} ${CAP}`); return; }
        if (sub === 'ACK' && wantsCap) { wantsCap = false; toClient(`${line} ${CAP}`); return; }
      }
      toClient(line);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  proxy.port = (server.address() as AddressInfo).port;
  return proxy;
}
