// A proxy between the app and the e2e ergo that adds IRCv3 chathistory
// (the e2e ergo runs with history off): it offers the `chathistory` cap,
// ACKs it when the app asks, and answers CHATHISTORY LATEST / BEFORE /
// AROUND itself, from a scripted backlog per channel. Everything else is ergo's.
// With `readMarker`, it also offers IRCv3 `draft/read-marker`: it keeps a read
// marker per channel, sends it after each JOIN, answers MARKREAD, and can
// push one as if another client of the account had read the channel.
import { createConnection, createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { IRC_HOST, IRC_PORT } from '../fixtures';

export interface HistoryLine {
  /** Unix ms. */
  time: number;
  from: string;
  text: string;
  /** PRIVMSG (default) or NOTICE. */
  kind?: 'PRIVMSG' | 'NOTICE';
  /** Who it was sent to (default: the conversation it's stored under). */
  to?: string;
}

export interface HistoryProxy {
  port: number;
  /** Set a channel's (or private conversation's) backlog (any order). */
  setHistory(channel: string, lines: HistoryLine[]): void;
  /** The private conversations CHATHISTORY TARGETS lists (default none). */
  setTargets(targets: string[]): void;
  /** Leave CHATHISTORY BEFORE unanswered (a server that went quiet). */
  stallBefore: boolean;
  /** The CHATHISTORY commands the app sent, in order. */
  readonly requests: string[];
  /** The MARKREAD commands the app sent, in order (readMarker only). */
  readonly markreads: string[];
  /** The stored read marker for a channel (ISO), if any. */
  marker(channel: string): string | undefined;
  /** Set a channel's marker without telling anyone (read while the app was away). */
  setMarker(channel: string, time: number): void;
  /** Another client read `channel` up to `time`: store it and tell every connection. */
  pushMarker(channel: string, time: number): void;
  close(): Promise<void>;
}

const CAP = 'chathistory';
const READ_MARKER = 'draft/read-marker';

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

const msgidOf = (l: HistoryLine): string => `hp-${l.time}-${l.from}`;

// A CHATHISTORY reference (timestamp=… or msgid=…) as a time; NaN if unknown.
function refTime(all: HistoryLine[], ref: string): number {
  if (ref.startsWith('timestamp=')) return Date.parse(ref.slice('timestamp='.length));
  if (ref.startsWith('msgid=')) return all.find((l) => msgidOf(l) === ref.slice('msgid='.length))?.time ?? NaN;
  return NaN;
}

export async function startHistoryProxy(opts: { readMarker?: boolean } = {}): Promise<HistoryProxy> {
  const history = new Map<string, HistoryLine[]>();
  const live = new Set<Socket>();
  const requests: string[] = [];
  const markreads: string[] = [];
  const markers = new Map<string, string>();
  // Connections that negotiated draft/read-marker: how to reach them.
  const markerClients = new Set<(line: string) => void>();
  const ours = opts.readMarker ? [CAP, READ_MARKER] : [CAP];
  let batchSeq = 0;
  let targets: string[] = [];
  const proxy: HistoryProxy = {
    port: 0,
    stallBefore: false,
    setHistory: (channel, ls) => { history.set(channel.toLowerCase(), ls); },
    setTargets: (ts) => { targets = ts; },
    requests,
    markreads,
    marker: (channel) => markers.get(channel.toLowerCase()),
    setMarker: (channel, time) => { markers.set(channel.toLowerCase(), new Date(time).toISOString()); },
    pushMarker: (channel, time) => {
      const iso = new Date(time).toISOString();
      markers.set(channel.toLowerCase(), iso);
      for (const send of markerClients) send(`:proxy.history MARKREAD ${channel} timestamp=${iso}`);
    },
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
    let wantsCap: string[] = [];
    let nick = '*';
    const markerLine = (target: string): string =>
      `:proxy.history MARKREAD ${target} timestamp=${markers.get(target.toLowerCase()) ?? '*'}`;
    client.on('close', () => markerClients.delete(toClient));

    const answer = (params: string[]): void => {
      const [sub = '', target = '', ref = '', limitArg = '50'] = params;
      // The private conversations set with setTargets (none by default).
      if (sub.toUpperCase() === 'TARGETS') {
        const id = `t${++batchSeq}`;
        toClient(`:proxy.history BATCH +${id} draft/chathistory-targets`);
        const stamp = new Date().toISOString();
        for (const t of targets) toClient(`@batch=${id} :proxy.history CHATHISTORY TARGETS ${t} ${stamp}`);
        toClient(`:proxy.history BATCH -${id}`);
        return;
      }
      const limit = Math.max(1, Number(limitArg) || 50);
      const all = [...(history.get(target.toLowerCase()) ?? [])].sort((a, b) => a.time - b.time);
      let page: HistoryLine[] = [];
      if (sub.toUpperCase() === 'LATEST') {
        page = all.slice(-limit);
      } else if (sub.toUpperCase() === 'BEFORE') {
        const ts = refTime(all, ref);
        const before = Number.isNaN(ts) ? all : all.filter((l) => l.time < ts);
        page = before.slice(-limit);
      } else if (sub.toUpperCase() === 'AROUND') {
        // Half before the reference, the rest from it on.
        const ts = refTime(all, ref);
        const at = all.findIndex((l) => l.time >= ts);
        const from = Math.max(0, (at < 0 ? all.length : at) - Math.floor(limit / 2));
        page = all.slice(from, from + limit);
      }
      const id = `h${++batchSeq}`;
      toClient(`:proxy.history BATCH +${id} chathistory ${target}`);
      for (const l of page) {
        toClient(`@batch=${id};time=${new Date(l.time).toISOString()};msgid=${msgidOf(l)} :${l.from}!h@history.test ${l.kind ?? 'PRIVMSG'} ${l.to ?? target} :${l.text}`);
      }
      toClient(`:proxy.history BATCH -${id}`);
    };

    lines(client, (line) => {
      const { command, params } = parse(line);
      if (command === 'NICK' && params[0]) nick = params[0];
      if (command === 'CAP' && (params[0] ?? '').toUpperCase() === 'REQ') {
        const caps = (params[params.length - 1] ?? '').split(' ').filter(Boolean);
        const mine = caps.filter((c) => ours.includes(c));
        if (mine.length > 0) {
          if (mine.includes(READ_MARKER)) markerClients.add(toClient);
          const rest = caps.filter((c) => !ours.includes(c));
          if (rest.length === 0) { toClient(`:proxy.history CAP ${nick} ACK :${mine.join(' ')}`); return; }
          wantsCap = mine;
          toUpstream(`CAP REQ :${rest.join(' ')}`);
          return;
        }
      }
      if (command === 'MARKREAD' && opts.readMarker) {
        markreads.push(line);
        const [target = '', ts] = params;
        if (ts) {
          const t = Date.parse(ts.replace(/^timestamp=/, ''));
          const cur = markers.get(target.toLowerCase());
          if (!Number.isNaN(t) && (!cur || t > Date.parse(cur))) markers.set(target.toLowerCase(), new Date(t).toISOString());
        }
        toClient(markerLine(target));
        return;
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
        if (sub === 'LS' && params[2] !== '*') { toClient(`${line} ${ours.join(' ')}`); return; }
        if (sub === 'ACK' && wantsCap.length > 0) { const mine = wantsCap; wantsCap = []; toClient(`${line} ${mine.join(' ')}`); return; }
      }
      if (command === '001' && params[0]) nick = params[0];
      toClient(line);
      // Like a server with the cap: the marker follows our own JOIN.
      if (command === 'JOIN' && markerClients.has(toClient) && params[0]) {
        const from = line.replace(/^@\S+ /, '').slice(1).split('!')[0] ?? '';
        if (from.toLowerCase() === nick.toLowerCase()) toClient(markerLine(params[0]));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  proxy.port = (server.address() as AddressInfo).port;
  return proxy;
}
