import { useEffect, useRef, useState } from 'preact/hooks';
import { MicOff, Video } from 'lucide-preact';
import type { ChatMessage } from '../../modules/chat/chat.types';
import { nickColor } from '../../modules/chat/nick-color';
import { useVideo } from '../../modules/video';
import { useVoice } from '../../modules/voice';
import { Avatar } from '../../shared/Avatar/Avatar';
import { roomPeople } from './VoiceRooms';
import './CallPanel.css';

// The right panel on the voice channel you're in (desktop), in place of
// MEMBERS: IN CALL — who's in, speakers first (with LIVE, camera and
// muted icons), and CHAT — the messages of the text channel the voice
// channel is under, with a composer. A voice channel that isn't under a
// text channel has no chat: IN CALL alone.

export interface CallChat {
  channel: string; // '#dev'
  messages: readonly ChatMessage[];
  onSend: (text: string) => void;
}

export function CallPanel({ chat, avatarFor, width }: {
  chat?: CallChat | null;
  avatarFor?: (nick: string) => string | undefined;
  width?: number;
}) {
  const { snap } = useVoice();
  const { snap: vsnap } = useVideo();
  const call = snap.call;
  const [tab, setTab] = useState<'people' | 'chat'>('people');
  const showChat = tab === 'chat' && !!chat;
  const { people } = roomPeople(call.participants, vsnap.state.tracks, vsnap.state.camera.on, vsnap.state.screen.on);
  const speakers = people.filter((x) => x.p.speaking);
  const quiet = people.filter((x) => !x.p.speaking);
  const row = (x: typeof people[number]) => (
    <li key={`${x.p.sessionId}:${x.p.userId}`} class="callpanel-person" data-speaking={x.p.speaking || undefined} data-self={x.self || undefined}
      aria-label={`${x.p.name}${x.self ? ' (you)' : ''}${x.p.speaking ? ', speaking' : ''}${x.screen ? ', sharing their screen' : ''}${x.camera ? ', camera on' : ''}${x.p.muted || x.p.deafened ? ', muted' : ''}`}>
      <span class="callpanel-face"><Avatar nick={x.p.name} url={avatarFor?.(x.p.name)} size={24} /></span>
      <span class="callpanel-name">{x.p.name}</span>
      {x.screen && <span class="voice-live" aria-hidden="true">LIVE</span>}
      {x.camera && <Video size={13} class="callpanel-cam" aria-hidden="true" />}
      {(x.p.muted || x.p.deafened) && <MicOff size={13} class="callpanel-muted" aria-hidden="true" />}
    </li>
  );
  return (
    <aside class="callpanel" aria-label="Call" style={width ? { width: `${width}px` } : undefined}>
      <div role="tablist" class="callpanel-tabs">
        <button type="button" role="tab" class="callpanel-tab" aria-selected={!showChat} onClick={() => setTab('people')}>
          IN CALL — {people.length}
        </button>
        {chat && (
          <button type="button" role="tab" class="callpanel-tab" aria-selected={showChat} onClick={() => setTab('chat')}>CHAT</button>
        )}
      </div>
      {!showChat ? (
        <div class="callpanel-people" role="tabpanel">
          {speakers.length > 0 && (
            <>
              <div class="callpanel-section">SPEAKING</div>
              <ul class="callpanel-list">{speakers.map(row)}</ul>
            </>
          )}
          <div class="callpanel-section">IN CALL</div>
          <ul class="callpanel-list">{quiet.map(row)}</ul>
        </div>
      ) : (
        <CallChatTab chat={chat!} />
      )}
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
        {shown.length === 0 && <div class="callpanel-empty">No messages in {chat.channel} yet.</div>}
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
        <input id="callpanel-input" class="callpanel-input" placeholder={`Message ${chat.channel}`} value={text}
          onInput={(e) => setText((e.target as HTMLInputElement).value)} />
      </form>
    </div>
  );
}
