import { useEffect, useRef, useState } from 'preact/hooks';
import { MicOff, Video } from 'lucide-preact';
import { EmptyState, Input } from '@boson/shared';
import type { ChatMessage } from '../../modules/chat/chat.types';
import { nickColor } from '../../modules/chat/nick-color';
import { Avatar } from '../../shared/Avatar/Avatar';
import { GuestBadge } from './GuestBadge';
import './CallPanel.css';

// The right panel on the voice channel you're in (desktop), in place of
// MEMBERS: the CHAT of the text channel the voice channel is under, with a
// composer. Who's in the call is on the stage's tiles (and under the voice
// channel in the sidebar), so it isn't listed a third time here; a voice
// channel that isn't under a text channel has no panel at all.

export interface CallChat {
  channel: string; // '#dev'
  messages: readonly ChatMessage[];
  onSend: (text: string) => void;
}

export function CallPanel({ chat, width }: { chat: CallChat; width?: number }) {
  return (
    <aside class="callpanel" aria-label={`Chat in ${chat.channel}`} style={width ? { width: `${width}px` } : undefined}>
      <div class="callpanel-head">Chat · {chat.channel}</div>
      <CallChatTab chat={chat} />
    </aside>
  );
}

// Who's in a voice channel, speakers first (with LIVE, camera, muted and
// guest marks): the right panel while you look at a voice channel before
// joining it (VoicePreJoin), in place of the text channel's members.
export interface PanelPerson {
  key: string;
  name: string;
  self?: boolean;
  guest?: boolean;
  speaking?: boolean;
  muted?: boolean;
  camera?: boolean;
  screen?: boolean;
}

export function PeoplePanel({ title, people, avatarFor, width, empty }: {
  title: string;
  people: readonly PanelPerson[];
  avatarFor?: (nick: string) => string | undefined;
  width?: number;
  empty?: string;
}) {
  const speakers = people.filter((x) => x.speaking);
  const quiet = people.filter((x) => !x.speaking);
  const row = (x: PanelPerson) => (
    <li key={x.key} class="callpanel-person" data-speaking={x.speaking || undefined} data-self={x.self || undefined}
      aria-label={`${x.name}${x.self ? ' (you)' : ''}${x.guest ? ', guest' : ''}${x.speaking ? ', speaking' : ''}${x.screen ? ', sharing their screen' : ''}${x.camera ? ', camera on' : ''}${x.muted ? ', muted' : ''}`}>
      <span class="callpanel-face"><Avatar nick={x.name} url={avatarFor?.(x.name)} size={24} /></span>
      <span class="callpanel-name">{x.name}</span>
      {x.guest && <GuestBadge />}
      {x.screen && <span class="voice-live" aria-hidden="true">LIVE</span>}
      {x.camera && <Video size={13} class="callpanel-cam" aria-hidden="true" />}
      {x.muted && <MicOff size={13} class="callpanel-muted" aria-hidden="true" />}
    </li>
  );
  return (
    <aside class="callpanel" aria-label={title} style={width ? { width: `${width}px` } : undefined}>
      <div class="callpanel-head">{title} — {people.length}</div>
      <div class="callpanel-people">
        {people.length === 0 && empty && <EmptyState class="callpanel-empty">{empty}</EmptyState>}
        {speakers.length > 0 && (
          <>
            <div class="callpanel-section">SPEAKING</div>
            <ul class="callpanel-list">{speakers.map(row)}</ul>
          </>
        )}
        {quiet.length > 0 && speakers.length > 0 && <div class="callpanel-section">LISTENING</div>}
        <ul class="callpanel-list">{quiet.map(row)}</ul>
      </div>
    </aside>
  );
}

function CallChatTab({ chat }: { chat: CallChat }) {
  const [text, setText] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const shown = chat.messages.filter((m) => m.kind === 'message' || m.kind === 'action').slice(-50);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length]);
  return (
    <div class="callpanel-chat" role="tabpanel">
      <div class="callpanel-messages" ref={list}>
        {shown.length === 0 && <EmptyState class="callpanel-empty">No messages in {chat.channel} yet.</EmptyState>}
        {shown.map((m) => (
          <div key={m.id} class="callpanel-msg">
            <span class="callpanel-from" style={{ color: nickColor(m.from) }}>{m.from}</span>
            <div class="callpanel-text">{m.kind === 'action' ? `* ${m.from} ${m.text}` : m.text}</div>
          </div>
        ))}
      </div>
      <form class="callpanel-compose" onSubmit={(e) => {
        e.preventDefault();
        const t = text.trim();
        if (!t) return;
        chat.onSend(t);
        setText('');
      }}>
        <label class="callpanel-sr" for="callpanel-input">Message {chat.channel}</label>
        <Input id="callpanel-input" placeholder={`Message ${chat.channel}`} value={text}
          onInput={(e) => setText((e.target as HTMLInputElement).value)} />
      </form>
    </div>
  );
}
