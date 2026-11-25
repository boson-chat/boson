import type { ChatMessage } from '../../modules/chat/chat.types';
import { SERVICE_CHANNEL, isServiceSender } from '../../modules/chat/services';
import type { MyDm } from './MySpace';

// One server's conversations, as MY's direct-message list needs them.
export interface DmSource {
  serverId: string;
  serverName: string;
  myNick: string;
  channels: ReadonlyArray<{ name: string; unread: number; mentions: number; messages: readonly ChatMessage[] }>;
}

const SAID = new Set(['message', 'action', 'notice']);

// When the conversation last heard from the other side: the newest line they
// sent, else (only our own lines so far) the newest line at all, else 0.
export function lastReceivedAt(messages: readonly ChatMessage[], myNick: string): number {
  const me = myNick.toLowerCase();
  let any = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (!SAID.has(m.kind)) continue;
    if (m.from && m.from.toLowerCase() !== me) return m.timestamp;
    if (!any) any = m.timestamp;
  }
  return any;
}

// MY's direct messages across every server: people only (no channels, no
// services or server senders, no ~server log), newest received first.
export function collectMyDms(sources: readonly DmSource[]): MyDm[] {
  const out: Array<MyDm & { at: number; order: number }> = [];
  for (const s of sources) {
    for (const ch of s.channels) {
      if (/^[#&]/.test(ch.name) || ch.name === SERVICE_CHANNEL || isServiceSender(ch.name)) continue;
      out.push({
        serverId: s.serverId, serverName: s.serverName, name: ch.name, unread: ch.unread, mentions: ch.mentions,
        at: lastReceivedAt(ch.messages, s.myNick), order: out.length,
      });
    }
  }
  out.sort((a, b) => b.at - a.at || a.order - b.order);
  return out.map(({ at: _at, order: _order, ...d }) => d);
}
