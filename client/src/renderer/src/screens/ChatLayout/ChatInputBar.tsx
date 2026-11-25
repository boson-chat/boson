import { useEffect, useRef, useState, useLayoutEffect } from 'preact/hooks';
import { CornerUpLeft, Paperclip, Plus, SendHorizontal, Smile, X } from 'lucide-preact';
import { Button, Input } from '@boson/shared';
import type { ChatInputBloc, ChatInputState } from './ChatInputBloc';
import {
  ChannelAutocomplete,
  MentionAutocomplete,
  SlashAutocomplete,
} from './chat-autocomplete';
import { EMOJI_LIST } from './emoji-data';
import { isTouchPhone, useNarrow } from '../../shared/narrow';

interface ChatInputBarProps {
  state: ChatInputState;
  bloc: ChatInputBloc;
  placeholder: string;
  bannerError?: string | null;
  onDismissBanner?: () => void;
  // Our current nick, shown as a chip on the left of the composer so the user
  // can always see who they are. Optional for legacy fixtures.
  myNick?: string;
  // Nothing can be sent yet (e.g. the channel's JOIN hasn't been confirmed):
  // the textarea and Send are disabled and the placeholder says why. The
  // draft is kept.
  disabled?: boolean;
  // File uploads (the network has a files host): the attach button opens
  // the file picker; pasted files and images go to onFiles too. Absent:
  // no attach button, and a paste is just text.
  onFiles?: (files: File[]) => void;
  // Replying to a message: a "Replying to nick" bar over the composer with
  // a way to cancel (its ×, or Escape in the composer).
  replying?: { nick: string; text: string } | null;
  onCancelReply?: () => void;
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
  disabled = false,
  onFiles,
  replying,
  onCancelReply,
}: ChatInputBarProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiQuery, setEmojiQuery] = useState('');
  // A phone: the keyboard's Return makes a newline (Send sends), and the
  // keyboard autocapitalizes and corrects as in other chat apps.
  const narrow = useNarrow();
  const phone = narrow && isTouchPhone();

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

  // Before paint: the composer is its new height in the same frame as the
  // text (the message list above shrinks or grows with it, and stays at
  // the bottom), not a frame later.
  useLayoutEffect(() => {
    autoResize(textareaRef.current);
  }, [state.input]);

  // Re-measure when the composer's width changes (window / panel resize, or
  // the first real layout after mounting into a not-yet-sized column): the
  // height depends on how the text wraps, and a measurement taken at the
  // wrong width otherwise sticks until the next keystroke.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return; // our own height writes
      lastWidth = el.clientWidth;
      autoResize(el);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Apply any pending cursor placement queued by an autocomplete commit or
  // nick tab-complete. The bloc stashes the target index in state and we
  // drain it here once the controlled-input value has actually flipped — in a
  // layout effect, so the caret is placed before the next keystroke can land
  // (typing straight after clicking a suggestion otherwise went to the old
  // caret position).
  useLayoutEffect(() => {
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
          <Button
            variant="ghost"
            size="sm"
            tone="danger"
            class="chat-banner-dismiss"
            aria-label="Dismiss"
            onClick={onDismissBanner}
            icon={<X aria-hidden="true" />}
          />
        </div>
      )}
      {replying && (
        <div class="chat-reply-bar" role="status">
          <CornerUpLeft aria-hidden="true" class="chat-reply-bar-icon" />
          <span class="chat-reply-bar-label">Replying to <strong>{replying.nick}</strong></span>
          <span class="chat-reply-bar-excerpt">{replying.text}</span>
          <Button
            variant="ghost"
            size={phone ? 'lg' : 'sm'}
            class="chat-reply-bar-cancel"
            title="Cancel reply (Esc)"
            aria-label="Cancel reply"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onCancelReply}
            icon={<X aria-hidden="true" />}
          />
        </div>
      )}
      <div class="chat-input-wrap">
        <div class="input-actions">
          {/* A phone has no room for the nick (the title bar shows it) or an
              emoji button (the keyboard has one): the text gets the width. */}
          {myNick && !phone && (
            <span class="chat-nick-chip" title={`You are ${myNick}`}>{myNick}</span>
          )}
          {onFiles && (
            <>
              <Button
                variant="ghost"
                size={phone ? 'lg' : 'sm'}
                class="input-action"
                title="Attach files"
                aria-label="Attach files"
                disabled={disabled}
                onClick={() => fileInputRef.current?.click()}
                icon={phone ? <Plus aria-hidden="true" /> : <Paperclip aria-hidden="true" />}
              />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                data-testid="attach-input"
                onChange={(e) => {
                  const el = e.currentTarget as HTMLInputElement;
                  const files = Array.from(el.files ?? []);
                  el.value = '';
                  if (files.length > 0) onFiles(files);
                }}
              />
            </>
          )}
          {!phone && <div class="emoji-picker-wrap">
            <Button
              variant="ghost"
              size="sm"
              class="input-action"
              title="Emoji"
              aria-label="Insert emoji"
              aria-expanded={emojiOpen}
              onClick={() => setEmojiOpen((v) => !v)}
              icon={<Smile aria-hidden="true" />}
            />
            {emojiOpen && (
              <div class="emoji-picker" role="dialog" aria-label="Emoji picker">
                <Input
                  inputSize="sm"
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
          </div>}
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
            disabled={disabled}
            rows={1}
            autocapitalize="sentences"
            autocorrect="on"
            spellcheck={phone}
            enterkeyhint={phone ? 'enter' : 'send'}
            value={state.input}
            onInput={(e) => bloc.setInput((e.target as HTMLTextAreaElement).value)}
            onPaste={(e) => {
              if (!onFiles) return;
              const files = Array.from(e.clipboardData?.files ?? []);
              if (files.length === 0) return;
              e.preventDefault();
              onFiles(files);
            }}
            onScroll={(e) => {
              if (overlayRef.current) {
                overlayRef.current.scrollTop = (e.currentTarget as HTMLTextAreaElement).scrollTop;
              }
            }}
            onKeyDown={(e) => {
              // Escape with no suggestion list open cancels a reply.
              if (e.key === 'Escape' && replying && onCancelReply
                && !state.slashOpen && !state.mentionOpen && !state.channelOpen) {
                e.preventDefault();
                onCancelReply();
                return;
              }
              bloc.handleKeyDown({
                key: e.key,
                shiftKey: e.shiftKey,
                preventDefault: () => e.preventDefault(),
                selectionStart:
                  (e.currentTarget as HTMLTextAreaElement).selectionStart,
                modKey: e.ctrlKey || e.metaKey,
                enterInsertsNewline: isTouchPhone(),
              });
            }}
          />
        </div>
        {phone ? (
          <Button
            // Nothing to send: the icon reads as a hint, not a dimmed
            // orange block.
            variant={disabled || !state.input.trim() ? 'ghost' : 'primary'}
            size="lg"
            class="chat-send-btn"
            // Keep the focus (and a phone's keyboard) in the composer: a tap
            // here would otherwise blur it and drop the keyboard after every
            // message.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => bloc.send()}
            disabled={disabled || !state.input.trim()}
            aria-label="Send"
            icon={<SendHorizontal aria-hidden="true" />}
          />
        ) : (
          <Button
            variant="primary"
            size="sm"
            class="chat-send-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => bloc.send()}
            disabled={disabled || !state.input.trim()}
            aria-label="Send"
          >
            Send
          </Button>
        )}
      </div>
    </div>
  );
}

export function autoResize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  // Measuring sets the height to auto for a moment. That shrank the whole
  // composer to one line and grew the message list above it for that
  // moment, and the list's scrollTop was clamped to fit: sent back up from
  // the bottom by the growth of the composer it should have stayed above.
  // Holding the box around the textarea at its height while measuring
  // keeps the rest of the layout where it is.
  const hold = el.parentElement;
  const held = hold ? hold.style.minHeight : '';
  if (hold) hold.style.minHeight = `${hold.getBoundingClientRect().height}px`;
  try {
    measure(el);
  } finally {
    if (hold) hold.style.minHeight = held;
  }
}

function measure(el: HTMLTextAreaElement): void {
  // Empty: fall back to the CSS min-height (one line). Chromium counts the
  // placeholder in scrollHeight, so measuring an empty textarea while its
  // column is still narrow wraps the placeholder per character and pins the
  // composer at max height.
  if (!el.value) {
    el.style.height = '';
    return;
  }
  el.style.height = 'auto';
  // Grows up to the CSS max-height (smaller on a phone), then scrolls inside.
  const max = parseFloat(getComputedStyle(el).maxHeight) || 160;
  el.style.height = Math.min(el.scrollHeight, max) + 'px';
}

