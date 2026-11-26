import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Signal } from '@preact/signals';
import { ArrowLeft, X } from 'lucide-preact';
import { Button, EmptyState } from '@boson/shared';
import type { ChatMember, ChatMessage, SendOptions } from '../../modules/chat';
import { threadIndexFor, threadReplyTarget } from '../../modules/chat/threads';
import { withoutReplyPrefix } from '../../modules/chat/replies';
import { ChatInputBloc, type ChatInputState } from './ChatInputBloc';
import { ChatInputBar } from './ChatInputBar';
import { MessageRow, excerptOf, useGuessedReplies, type ReplyContextSource } from './message-render';
import type { NickActions } from './nick-actions';
import './ThreadPanel.css';

// The sheet carries the phone layout's classes (app-shell is-narrow), so
// its rows and composer look as they do in the conversation.
//
// A thread (threads.ts): its root, then every reply in it by time, with a
// composer of its own. On a desktop it's the right-hand column beside the
// conversation (where the member list goes); on a phone a full-height
// sheet over it.
//
// What's sent here is an ordinary reply (ChatService.send): to the
// thread's newest line from someone else unless another line's Reply was
// picked, with the `+draft/reply` tag where the server relays it and the
// `nick: ` / `nick: "quote..." ` text every client reads. Classic clients
// see plain lines addressed to someone; the main timeline shows them too.

export interface ThreadPanelProps {
  /** The thread, by its root's id (a root that has since been found to
   *  answer an older line follows it: the thread moves up). */
  rootId: string;
  messages: Signal<ChatMessage[]>;
  channelName: string;
  myNick: string;
  members: ChatMember[];
  knownChannels?: readonly string[];
  avatarFor?: (nick: string) => string | undefined;
  nickActions?: NickActions;
  replyContext?: ReplyContextSource | null;
  onSend: (message: string, opts?: SendOptions) => void;
  onTyping?: (state: 'active' | 'done') => void;
  onClose: () => void;
  /** Show a message in the main timeline. */
  onJumpTo: (m: ChatMessage) => void;
  /** 'side': the desktop column; 'sheet': a phone's full-height sheet. */
  variant?: 'side' | 'sheet';
  width?: number;
  /** Nothing can be sent (the channel isn't joined yet). */
  disabled?: boolean;
}

export function ThreadPanel(props: ThreadPanelProps) {
  const body = <ThreadPanelBody {...props} />;
  if (props.variant !== 'sheet') return body;
  // Under a narrow desktop window's title bar (above the sheet, with the
  // window's controls); a phone has none.
  const top = Math.max(0, document.querySelector('.title-bar')?.getBoundingClientRect().bottom ?? 0);
  return createPortal(
    <div class="app-shell is-narrow thread-sheet-layer" style={top ? `--sheet-top:${Math.round(top)}px` : undefined}>{body}</div>,
    document.body,
  );
}

function ThreadPanelBody({
  rootId, messages, channelName, myNick, members, knownChannels = [], avatarFor, nickActions, replyContext,
  onSend, onTyping, onClose, onJumpTo, variant = 'side', width, disabled = false,
}: ThreadPanelProps) {
  const all = messages.value;
  const index = threadIndexFor(messages);
  index.sync(all);
  void replyContext?.version.value;
  const root = index.rootOf(rootId);
  const thread = useMemo(() => index.messages(root), [index, root, index.version, all]);
  const guessedReplies = useGuessedReplies();

  // The line a send answers: one picked (a line's Reply here), else the
  // thread's newest from someone else.
  const [picked, setPicked] = useState<ChatMessage | null>(null);
  useEffect(() => { setPicked(null); }, [root]);
  const pickedNow = picked ? index.get(picked.id) ?? null : null;
  const target = pickedNow ?? threadReplyTarget(thread, myNick) ?? null;
  const targetRef = useRef(target);
  targetRef.current = target;

  const membersRef = useRef<readonly { nick: string }[]>(members);
  membersRef.current = members;
  const knownRef = useRef(knownChannels);
  knownRef.current = knownChannels;
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const onTypingRef = useRef(onTyping);
  onTypingRef.current = onTyping;
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const bloc = useMemo(() => new ChatInputBloc({
    getMembers: () => membersRef.current,
    getKnownChannels: () => knownRef.current,
    onSend: (lines) => {
      // The reply rides the first line (a paste's later lines follow it).
      const t = targetRef.current;
      lines.forEach((line, i) => {
        if (i === 0 && t) onSendRef.current(line, { ...(t.msgid ? { replyTo: t.msgid } : {}), replyToId: t.id });
        else onSendRef.current(line);
      });
      setPicked(null);
      stick.current = true;
    },
    onTyping: (s) => onTypingRef.current?.(s),
  }), []);
  const [state, setState] = useState<ChatInputState>(() => bloc.getState());
  useEffect(() => bloc.subscribe(setState), [bloc]);

  const focusComposer = (): void => {
    const input = bloc.getState().input;
    bloc.insertAtCursor('', input.length, input.length);
  };
  const rowActions = useMemo<NickActions | undefined>(() => (nickActions ? {
    ...nickActions,
    onMention: (nick: string) => {
      const tag = `@${nick} `;
      const input = bloc.getState().input;
      if (!input.startsWith(tag)) bloc.insertAtCursor(tag, 0, 0);
      else bloc.insertAtCursor('', input.length, input.length);
    },
    onReply: (m: ChatMessage) => { setPicked(m); focusComposer(); },
  } : undefined), [nickActions, bloc]);

  // Opened: the composer takes the focus (not on a phone, where that
  // would put the keyboard over the thread).
  useEffect(() => { if (variant === 'side') focusComposer(); }, [root]);

  // The newest reply in view: opened at the bottom, and kept there as
  // replies come in while it is.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => { stick.current = true; }, [root]);
  const onScroll = (e: Event): void => {
    const el = e.currentTarget as HTMLDivElement;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  // Rows that change height after they're laid out (an embed loading).
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight; });
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => ro.disconnect();
  });

  // Escape (not in the composer, which uses it to cancel a picked reply)
  // closes the thread.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (t?.tagName === 'TEXTAREA' && (picked || state.input)) return;
    e.preventDefault();
    onClose();
  };

  // Each line's quote: what it answers. Left out right under that line.
  const missing: string[] = [];
  const parentOf = (m: ChatMessage): ChatMessage | null | 'loading' | undefined => {
    if (m.redacted) return undefined;
    if (m.replyTo) {
      const p = index.byMsgidOf(m.replyTo);
      if (p) return p;
      const c = replyContext ? replyContext.get(m.replyTo) : null;
      if (c === undefined) missing.push(m.replyTo);
      return c === undefined ? 'loading' : c;
    }
    if (m.replyToId) {
      if (m.replyGuess && !guessedReplies) return undefined;
      return index.get(m.replyToId) ?? null;
    }
    return undefined;
  };
  useEffect(() => { if (replyContext && missing.length > 0) replyContext.request(missing); });

  const display = channelName.replace(/^[#&]/, '');
  const prefix = /^[#&]/.test(channelName) ? '#' : '@';
  const rootMsg = thread[0];
  const replies = thread.length - 1;
  const style = variant === 'side' && width ? { width: `${width}px` } : undefined;
  return (
    <aside class={`thread-panel thread-panel-${variant}`} style={style} aria-label={`Thread in ${prefix}${display}`}
      role={variant === 'sheet' ? 'dialog' : undefined} aria-modal={variant === 'sheet' ? true : undefined}
      onKeyDown={onKeyDown}>
      <div class="thread-panel-head">
        {variant === 'sheet' && (
          <Button variant="ghost" size="lg" class="thread-panel-back" onClick={onClose} aria-label="Close thread"
            icon={<ArrowLeft aria-hidden="true" />} />
        )}
        <div class="thread-panel-title">
          <span class="thread-panel-name">Thread</span>
          <span class="thread-panel-where">{prefix}{display}</span>
        </div>
        {variant === 'side' && (
          <Button variant="ghost" size="sm" class="thread-panel-close" onClick={onClose} title="Close thread (Esc)"
            aria-label="Close thread" icon={<X aria-hidden="true" />} />
        )}
      </div>
      <div class="thread-panel-list" ref={listRef} onScroll={onScroll}>
        {!rootMsg ? (
          <EmptyState class="thread-panel-empty">This thread isn't loaded any more.</EmptyState>
        ) : thread.map((m, i) => {
          const parent = parentOf(m);
          const prev = i > 0 ? thread[i - 1] : undefined;
          const hideQuote = i > 0 && !!parent && parent !== 'loading' && (parent.id === root || parent.id === prev?.id);
          return (
            <div key={m.id} class={`thread-panel-row${i === 0 ? ' thread-panel-root' : ''}`}>
              <MessageRow
                msg={m}
                myNick={myNick}
                members={members}
                nickActions={rowActions}
                avatarFor={avatarFor}
                replyParent={parent}
                hideQuote={hideQuote}
                onJumpTo={onJumpTo}
                onShowInConversation={onJumpTo}
              />
              {i === 0 && (
                <div class="thread-panel-divider" role="separator">
                  <span>{replies} {replies === 1 ? 'reply' : 'replies'}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <ChatInputBar
        state={state}
        bloc={bloc}
        placeholder={target ? `Reply in thread` : `Message ${prefix}${display}`}
        disabled={disabled}
        myNick={myNick}
        replying={target ? { nick: target.from, text: excerptOf(target.replyGuess ? target.text : withoutReplyPrefix(target.text)), cancelLabel: 'Reply to the latest instead' } : null}
        onCancelReply={picked ? () => setPicked(null) : undefined}
      />
    </aside>
  );
}
