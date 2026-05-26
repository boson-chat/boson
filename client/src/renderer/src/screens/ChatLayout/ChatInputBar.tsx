import { useEffect, useRef } from 'preact/hooks';
import type { ChatInputBloc, ChatInputState } from './ChatInputBloc';
import {
  ChannelAutocomplete,
  MentionAutocomplete,
  SlashAutocomplete,
} from './chat-autocomplete';

interface ChatInputBarProps {
  state: ChatInputState;
  bloc: ChatInputBloc;
  placeholder: string;
  bannerError?: string | null;
  onDismissBanner?: () => void;
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
}: ChatInputBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

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
          <button class="input-action" type="button" title="Attach (coming soon)" disabled>[+]</button>
          <button class="input-action" type="button" title="Emoji (coming soon)" disabled>[e]</button>
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
