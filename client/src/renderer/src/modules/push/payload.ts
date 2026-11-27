// What a push carries (docs/push.md §0, §3.3): the server sends the IRC
// line itself, as Ergo's draft/webpush does — a PRIVMSG / NOTICE that was a
// DM or a highlight, a MARKREAD when the conversation was read elsewhere,
// or `PING webpush` to test a new subscription. Shared by every receiver
// that runs JavaScript: the renderer and the web client's service worker
// (platform/web/push-sw.ts). The iOS Notification Service Extension
// (desktop/build/ios/push/) and the Android FCM service
// (desktop/build/android/…/BosonPushService.java) mirror it.

export interface ParsedLine {
  tags: Record<string, string>;
  // nick!user@host or a server name; '' when the line has no source.
  source: string;
  command: string;
  params: string[];
}

// IRCv3 tag value escapes.
function unescapeTag(v: string): string {
  return v.replace(/\\(.)?/g, (_m, c: string | undefined) => {
    switch (c) {
      case ':': return ';';
      case 's': return ' ';
      case '\\': return '\\';
      case 'r': return '\r';
      case 'n': return '\n';
      case undefined: return '';
      default: return c;
    }
  });
}

// One IRC line (RFC 1459 + IRCv3 tags). null when it isn't one.
export function parseLine(raw: string): ParsedLine | null {
  let s = raw.replace(/[\r\n]+$/, '');
  const tags: Record<string, string> = {};
  if (s.startsWith('@')) {
    const sp = s.indexOf(' ');
    if (sp < 0) return null;
    for (const t of s.slice(1, sp).split(';')) {
      if (!t) continue;
      const eq = t.indexOf('=');
      if (eq < 0) tags[t] = '';
      else tags[t.slice(0, eq)] = unescapeTag(t.slice(eq + 1));
    }
    s = s.slice(sp + 1).replace(/^ +/, '');
  }
  let source = '';
  if (s.startsWith(':')) {
    const sp = s.indexOf(' ');
    if (sp < 0) return null;
    source = s.slice(1, sp);
    s = s.slice(sp + 1).replace(/^ +/, '');
  }
  const params: string[] = [];
  let command = '';
  while (s.length) {
    if (command && s.startsWith(':')) { params.push(s.slice(1)); break; }
    const sp = s.indexOf(' ');
    const word = sp < 0 ? s : s.slice(0, sp);
    if (!command) command = word.toUpperCase();
    else params.push(word);
    if (sp < 0) break;
    s = s.slice(sp + 1).replace(/^ +/, '');
  }
  if (!command) return null;
  return { tags, source, command, params };
}

export type PushMessage =
  // A new subscription's test push: nothing to show.
  | { type: 'ping' }
  // The conversation was read on another device: take its notifications down.
  | { type: 'read'; target: string; time?: string }
  | {
    type: 'message';
    // dm: sent to us; mention: a channel line that highlights us.
    kind: 'dm' | 'mention';
    nick: string;
    account?: string;
    // The channel, or for a DM the sender's nick: the buffer it opens.
    conversation: string;
    text: string;
    // /me
    action: boolean;
    notice: boolean;
    msgid?: string;
    time?: string;
  }
  // Anything else (a future push type): ignored.
  | { type: 'other' };

const isChannel = (t: string): boolean => /^[#&!+]/.test(t);

export function parsePush(raw: string): PushMessage {
  const line = parseLine(raw);
  if (!line) return { type: 'other' };
  if (line.command === 'PING') return { type: 'ping' };
  if (line.command === 'MARKREAD') {
    const target = line.params[0] ?? '';
    const ts = (line.params[1] ?? '').replace(/^timestamp=/, '');
    if (!target) return { type: 'other' };
    return { type: 'read', target, ...(ts && ts !== '*' ? { time: ts } : {}) };
  }
  if (line.command !== 'PRIVMSG' && line.command !== 'NOTICE') return { type: 'other' };
  const target = line.params[0] ?? '';
  let text = line.params[1] ?? '';
  // From a person (nick!user@host), not the server itself.
  const bang = line.source.indexOf('!');
  if (!target || bang <= 0) return { type: 'other' };
  const nick = line.source.slice(0, bang);
  let action = false;
  if (text.startsWith('\x01')) {
    const m = /^\x01ACTION ?([^\x01]*)\x01?$/.exec(text);
    if (!m) return { type: 'other' }; // other CTCPs aren't messages
    action = true;
    text = m[1] ?? '';
  }
  const channel = isChannel(target);
  return {
    type: 'message',
    kind: channel ? 'mention' : 'dm',
    nick,
    ...(line.tags['account'] ? { account: line.tags['account'] } : {}),
    conversation: channel ? target : nick,
    text,
    action,
    notice: line.command === 'NOTICE',
    ...(line.tags['msgid'] ? { msgid: line.tags['msgid'] } : {}),
    ...(line.tags['time'] ? { time: line.tags['time'] } : {}),
  };
}

// IRC formatting (bold, colours, …) and control characters out, whitespace
// collapsed, clamped to a banner's length.
export function cleanText(s: string, max = 180): string {
  const t = s
    .replace(/\x03(\d{1,2}(,\d{1,2})?)?/g, '')
    .replace(/\x04([0-9a-fA-F]{6}(,[0-9a-fA-F]{6})?)?/g, '')
    .replace(/[\x02\x0f\x11\x16\x1d\x1e\x1f]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export interface PushText {
  // "<nick> in #channel", or "<nick>" for a DM.
  title: string;
  // The server's name (iOS shows it as the subtitle; others append it).
  subtitle: string;
  body: string;
  // Collapses repeats per conversation; the same key the renderer's own
  // notifications use (modules/ui/notifier.ts).
  tag: string;
}

export function pushText(m: Extract<PushMessage, { type: 'message' }>, serverId: string, serverName: string): PushText {
  const text = cleanText(m.text);
  return {
    title: m.kind === 'dm' ? m.nick : `${m.nick} in ${m.conversation}`,
    subtitle: serverName,
    body: m.action ? cleanText(`* ${m.nick} ${m.text}`) : text,
    tag: notificationTag(serverId, m.conversation),
  };
}

export function notificationTag(serverId: string, conversation: string): string {
  return `${serverId}:${conversation.toLowerCase()}`;
}
