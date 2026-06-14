import { useEffect, useRef, useState } from 'preact/hooks';
import type { ChatInputBloc, ChatInputState } from './ChatInputBloc';
import {
  ChannelAutocomplete,
  MentionAutocomplete,
  SlashAutocomplete,
} from './chat-autocomplete';
import { EMOJI_LIST } from './emoji-data';

interface ChatInputBarProps {
  state: ChatInputState;
  bloc: ChatInputBloc;
  placeholder: string;
  bannerError?: string | null;
  onDismissBanner?: () => void;
  // Our current nick, shown as a chip on the left of the composer so the user
  // can always see who they are. Optional for legacy fixtures.
  myNick?: string;
}

// The composer area below the message list. Renders the slash/mention/channel
// popups, the styled overlay mirror, the actual textarea, and the send
// button. All state lives in the parent's ChatInputBloc; this component is
// pure view + cursor/auto-resize side-effects.
export function ChatInputBar({
  state,
  bloc,
  placeholder,
  bannerError,
  onDismissBanner,
  myNick,
}: ChatInputBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiQuery, setEmojiQuery] = useState('');

  // Insert an emoji char at the textarea's current selection, then refocus.
  const insertEmoji = (char: string): void => {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? state.input.length;
    const end = el?.selectionEnd ?? start;
    bloc.insertAtCursor(char, start, end);
    setEmojiOpen(false);
    setEmojiQuery('');
  };
  const emojiMatches = emojiQuery
    ? EMOJI_LIST.filter((e) => e.code.includes(emojiQuery.toLowerCase()))
    : EMOJI_LIST;

  // Close the emoji picker on an outside click.
  useEffect(() => {
    if (!emojiOpen) return undefined;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest('.emoji-picker-wrap')) return;
      setEmojiOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [emojiOpen]);

  useEffect(() => {
    autoResize(textareaRef.current);
  }, [state.input]);

  // Apply any pending cursor placement queued by an autocomplete commit or
  // nick tab-complete. The bloc stashes the target index in state and we
  // drain it here once the controlled-input value has actually flipped.
  useEffect(() => {
    if (state.pendingCursor === null) return;
    const el = textareaRef.current;
    if (!el) return;
    const pos = state.pendingCursor;
    bloc.clearPendingCursor();
    el.focus();
    el.setSelectionRange(pos, pos);
  }, [state.input, state.pendingCursor, bloc]);

  return (
    <div class="chat-input-bar">
      {bannerError && (
        <div class="chat-banner chat-banner-error" role="alert">
          <span class="chat-banner-text">{bannerError}</span>
          <button
            class="chat-banner-dismiss"
            type="button"
            aria-label="Dismiss"
            onClick={onDismissBanner}
          >
            ×
          </button>
        </div>
      )}
      <div class="chat-input-wrap">
        <div class="input-actions">
          {myNick && (
            <span class="chat-nick-chip" title={`You are ${myNick}`}>{myNick}</span>
          )}
          <button class="input-action" type="button" title="Attach (coming soon)" disabled>[+]</button>
          <div class="emoji-picker-wrap">
            <button
              class="input-action"
              type="button"
              title="Emoji"
              aria-label="Insert emoji"
              aria-expanded={emojiOpen}
              onClick={() => setEmojiOpen((v) => !v)}
            >
              <EmojiIcon />
            </button>
            {emojiOpen && (
              <div class="emoji-picker" role="dialog" aria-label="Emoji picker">
                <input
                  class="emoji-picker-search"
                  type="text"
                  placeholder="Search…"
                  value={emojiQuery}
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autofocus
                  onInput={(e) => setEmojiQuery((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') { setEmojiOpen(false); setEmojiQuery(''); } }}
                />
                <div class="emoji-picker-grid">
                  {emojiMatches.map((e) => (
                    <button
                      key={e.code}
                      type="button"
                      class="emoji-picker-item"
                      title={`:${e.code}:`}
                      aria-label={`:${e.code}:`}
                      onClick={() => insertEmoji(e.char)}
                    >
                      {e.char}
                    </button>
                  ))}
                  {emojiMatches.length === 0 && <span class="emoji-picker-empty">No matches</span>}
                </div>
              </div>
            )}
          </div>
        </div>
        <div class="chat-textarea-wrap">
          {state.slashOpen && (
            <SlashAutocomplete
              matches={state.slashMatches}
              selected={state.slashSelected}
              onHover={(idx) => bloc.setSlashSelected(idx)}
              onPick={(idx) => {
                bloc.setSlashSelected(idx);
                bloc.acceptSlash();
              }}
            />
          )}
          {state.mentionOpen && (
            <MentionAutocomplete
              matches={state.mentionMatches}
              selected={state.mentionSelected}
              onHover={(idx) => bloc.setMentionSelected(idx)}
              onPick={(idx) => {
                bloc.setMentionSelected(idx);
                bloc.acceptMention();
              }}
            />
          )}
          {state.channelOpen && (
            <ChannelAutocomplete
              matches={state.channelMatches}
              selected={state.channelSelected}
              onHover={(idx) => bloc.setChannelSelected(idx)}
              onPick={(idx) => {
                bloc.setChannelSelected(idx);
                bloc.acceptChannel();
              }}
            />
          )}
          <div class="chat-textarea-overlay" aria-hidden="true" ref={overlayRef}>
            {state.tokens.map((t, i) => (
              <span key={i} class={`chat-token chat-token-${t.type}`}>{t.value}</span>
            ))}
            {/* trailing newline-friendly spacer so the overlay matches
                textarea's behavior when the last char is a newline */}
            {state.input.endsWith('\n') && <span class="chat-token chat-token-text">{'​'}</span>}
          </div>
          <textarea
            ref={textareaRef}
            class="chat-textarea"
            placeholder={placeholder}
            rows={1}
            value={state.input}
            onInput={(e) => bloc.setInput((e.target as HTMLTextAreaElement).value)}
            onScroll={(e) => {
              if (overlayRef.current) {
                overlayRef.current.scrollTop = (e.currentTarget as HTMLTextAreaElement).scrollTop;
              }
            }}
            onKeyDown={(e) => {
              bloc.handleKeyDown({
                key: e.key,
                shiftKey: e.shiftKey,
                preventDefault: () => e.preventDefault(),
                selectionStart:
                  (e.currentTarget as HTMLTextAreaElement).selectionStart,
              });
            }}
          />
        </div>
        <button
          class="chat-send-btn"
          type="button"
          onClick={() => bloc.send()}
          disabled={!state.input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function autoResize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

// Smiley face — an SVG so it renders identically on every OS (unlike the 😀
// glyph, which varies by platform emoji font).
function EmojiIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.3" />
      <circle cx="5.8" cy="6.6" r="0.95" fill="currentColor" />
      <circle cx="10.2" cy="6.6" r="0.95" fill="currentColor" />
      <path d="M5 9.6 C5.9 11.1 10.1 11.1 11 9.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    </svg>
  );
}
