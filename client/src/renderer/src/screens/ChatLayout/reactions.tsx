// Reactions (IRCv3 `+draft/react`) and deleting messages (IRCv3
// `draft/message-redaction`) on a message row: the chips under it, the
// picker, who reacted, and the delete confirm. Kept out of message-render so
// the row only wires these in (useMessageExtras).
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { Signal } from '@preact/signals';
import { Button, ConfirmDialog, Input } from '@boson/shared';
import { SmilePlus, Trash2 } from 'lucide-preact';
import type { ChatMessage } from '../../modules/chat';
import { reactionChips, whoReacted, type ReactionChip, type ReactionLog } from '../../modules/chat/reactions';
import type { SheetAction } from './BottomSheet';
import { EMOJI_LIST } from './emoji-data';
import { useLongPress } from './long-press';
import { isNarrow } from '../../shared/narrow';
import './reactions.css';

/** What a message row may do beyond reply / copy (NickActions.message). */
export interface MessageActions {
  /** Reactions can be sent to it (message-tags, and it has a msgid). */
  canReact: (msg: ChatMessage) => boolean;
  /** React (`on`) or take our reaction back. */
  react: (msg: ChatMessage, emoji: string, on: boolean) => void;
  /** The conversation's reactions by msgid (a signal: reading subscribes). */
  reactions: Signal<ReactionLog> | null;
  /** It's ours and the server lets us delete (draft/message-redaction). */
  canDelete: (msg: ChatMessage) => boolean;
  remove: (msg: ChatMessage) => void;
}

/** The picker's first row; "more" opens the full list. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'] as const;

// Where the picker opens: by what opened it, or (phones) docked at the bottom.
type PickerAt = { x: number; y: number } | 'dock';

/**
 * A row's reactions and delete, as pieces the row places: toolbar buttons
 * (desktop hover), menu / sheet actions, the chips, and the overlays.
 */
export function useMessageExtras(msg: ChatMessage, myNick: string, actions: MessageActions | undefined) {
  const [picker, setPicker] = useState<PickerAt | null>(null);
  const [confirming, setConfirming] = useState(false);
  const canReact = !!actions && !msg.pending && !msg.redacted && actions.canReact(msg);
  const canDelete = !!actions && !msg.pending && !msg.redacted && actions.canDelete(msg);
  const mine = !!myNick && msg.from.toLowerCase() === myNick.toLowerCase();

  const openPickerAt = (el: Element | null): void => {
    if (!el || isNarrow()) { setPicker('dock'); return; }
    const r = el.getBoundingClientRect();
    setPicker({ x: r.right, y: r.bottom + 4 });
  };

  const toolbarButtons = (
    <>
      {canReact && (
        <Button variant="ghost" size="sm" class="message-toolbar-btn" title="Add reaction" aria-label="Add reaction"
          icon={<SmilePlus aria-hidden="true" />}
          onClick={(e: MouseEvent) => openPickerAt(e.currentTarget as Element)} />
      )}
      {canDelete && (
        <Button variant="ghost" size="sm" class="message-toolbar-btn message-toolbar-btn-danger" title="Delete" aria-label="Delete message"
          icon={<Trash2 aria-hidden="true" />} onClick={() => setConfirming(true)} />
      )}
    </>
  );

  // For the right-click menu (`at`: where it was opened) and the phone sheet.
  const menuActions = (at?: { x: number; y: number }): SheetAction[] => {
    const out: SheetAction[] = [];
    if (canReact) out.push({ label: 'Add reaction', onClick: () => setPicker(at && !isNarrow() ? at : 'dock') });
    if (canDelete) out.push({ label: 'Delete message', danger: true, onClick: () => setConfirming(true) });
    return out;
  };

  const chips = actions && msg.msgid && !msg.redacted
    ? <ReactionChips msg={msg} myNick={myNick} actions={actions} canReact={canReact} onAdd={openPickerAt} />
    : null;

  const overlays = (
    <>
      {picker && actions && (
        <ReactionPicker
          at={picker}
          onPick={(emoji) => {
            setPicker(null);
            const mine = actions.reactions?.peek().get(msg.msgid ?? '')
              ?.some((r) => r.on && r.emoji === emoji && r.nick.toLowerCase() === myNick.toLowerCase());
            if (!mine) actions.react(msg, emoji, true);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {confirming && actions && (
        <ConfirmDialog
          open
          title={mine ? 'Delete message?' : `Delete ${msg.from}'s message?`}
          confirmLabel="Delete"
          onConfirm={() => { setConfirming(false); actions.remove(msg); }}
          onCancel={() => setConfirming(false)}
        >
          {mine
            ? "It's deleted for everyone in the conversation."
            : `You're deleting someone else's message, as a channel operator. It's deleted for everyone in the conversation.`}
          {' '}Apps that don't support deleting may still show it.
        </ConfirmDialog>
      )}
    </>
  );

  return { canReact, canDelete, toolbarButtons, menuActions, chips, overlays };
}

/** In place of a deleted message's text. */
export function DeletedText() {
  return <span class="message-deleted">Message deleted</span>;
}

interface ReactionChipsProps {
  msg: ChatMessage;
  myNick: string;
  actions: MessageActions;
  canReact: boolean;
  onAdd: (el: Element | null) => void;
}

// The chips under a message: emoji and count; ours highlighted. A click on
// ours takes it back, on another adds ours. Hover (desktop) or a long press
// (phones) shows who reacted.
function ReactionChips({ msg, myNick, actions, canReact, onAdd }: ReactionChipsProps) {
  // Reading the signal here subscribes this component, not the row.
  const entries = actions.reactions?.value.get(msg.msgid!);
  const chips = reactionChips(entries, myNick);
  const [who, setWho] = useState<{ chip: ReactionChip; rect: DOMRect } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPress = useLongPress(isNarrow);
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);
  // A tap elsewhere closes the phone's who-reacted bubble.
  useEffect(() => {
    if (!who || !isNarrow()) return undefined;
    const close = (): void => setWho(null);
    const t = setTimeout(() => document.addEventListener('touchstart', close, { once: true }), 0);
    return () => { clearTimeout(t); document.removeEventListener('touchstart', close); };
  }, [who]);
  if (chips.length === 0) return null;
  const live = who ? chips.find((c) => c.emoji === who.chip.emoji) : undefined;
  return (
    // A press on a chip is the chip's, not the row's (its long press opens
    // the message sheet).
    <div class="reaction-bar" role="group" aria-label="Reactions"
      onTouchStart={stop} onTouchMove={stop} onTouchEnd={stop} onContextMenu={stop}>
      {chips.map((chip) => {
        const label = whoReacted(chip, myNick);
        let chipEl: HTMLButtonElement | null = null;
        const press = longPress(() => { if (chipEl) setWho({ chip, rect: chipEl.getBoundingClientRect() }); });
        return (
          <button
            key={chip.emoji}
            ref={(el) => { chipEl = el; }}
            type="button"
            class={`reaction-chip${chip.mine ? ' reaction-chip-mine' : ''}`}
            aria-pressed={chip.mine}
            aria-label={`${label}. ${chip.mine ? 'Remove your reaction' : 'React with this too'}`}
            disabled={!canReact && !chip.mine}
            onClick={() => {
              if (chip.mine) actions.react(msg, chip.emoji, false);
              else if (canReact) actions.react(msg, chip.emoji, true);
            }}
            onMouseEnter={(e) => {
              if (isNarrow()) return;
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              if (hoverTimer.current) clearTimeout(hoverTimer.current);
              hoverTimer.current = setTimeout(() => setWho({ chip, rect }), 250);
            }}
            onMouseLeave={() => {
              if (hoverTimer.current) clearTimeout(hoverTimer.current);
              if (!isNarrow()) setWho(null);
            }}
            {...press}
          >
            <span class="reaction-chip-emoji">{chip.emoji}</span>
            <span class="reaction-chip-count">{chip.count}</span>
          </button>
        );
      })}
      {canReact && (
        <button type="button" class="reaction-chip reaction-chip-add" title="Add reaction" aria-label="Add reaction"
          onClick={(e) => onAdd(e.currentTarget as Element)}>
          <SmilePlus aria-hidden="true" />
        </button>
      )}
      {who && live && <WhoReacted text={whoReacted(live, myNick)} rect={who.rect} />}
    </div>
  );
}

const stop = (e: Event): void => e.stopPropagation();

// The who-reacted bubble, above the chip (below it near the top edge).
function WhoReacted({ text, rect }: { text: string; rect: DOMRect }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - 8));
    const top = rect.top - h - 6 < 8 ? rect.bottom + 6 : rect.top - h - 6;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });
  return createPortal(
    <div ref={ref} class="reaction-who" role="tooltip">{text}</div>,
    document.body,
  );
}

interface ReactionPickerProps {
  at: PickerAt;
  onPick: (emoji: string) => void;
  onClose: () => void;
}

// A few common reactions, and "more": the composer's emoji list, searchable.
export function ReactionPicker({ at, onPick, onClose }: ReactionPickerProps) {
  const [more, setMore] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onDown = (e: Event): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current();
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); } };
    // After the click that opened it.
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('touchstart', onDown, true);
    }, 0);
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('touchstart', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  // Desktop: right-aligned under what opened it, kept in the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || at === 'dock') return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(at.x - w, window.innerWidth - w - 8));
    const top = at.y + h > window.innerHeight - 8 ? Math.max(8, at.y - h - 40) : at.y;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });

  const matches = query ? EMOJI_LIST.filter((e) => e.code.includes(query.toLowerCase())) : EMOJI_LIST;
  const pick = (emoji: string) => (e: MouseEvent): void => { e.preventDefault(); onPick(emoji); };

  return createPortal(
    <div ref={ref} class={`reaction-picker${at === 'dock' ? ' reaction-picker-dock' : ''}`} role="dialog" aria-label="Add reaction">
      <div class="reaction-picker-quick">
        {QUICK_REACTIONS.map((emoji) => (
          <button key={emoji} type="button" class="reaction-picker-quick-item" aria-label={`React with ${emoji}`} onClick={pick(emoji)}>
            {emoji}
          </button>
        ))}
        <button type="button" class={`reaction-picker-more${more ? ' is-open' : ''}`} aria-label="More reactions"
          aria-expanded={more} onClick={() => setMore((v) => !v)}>
          <SmilePlus aria-hidden="true" />
        </button>
      </div>
      {more && (
        <div class="reaction-picker-all">
          <Input
            inputSize="sm"
            type="text"
            placeholder="Search…"
            aria-label="Search emoji"
            value={query}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autofocus={!isNarrow()}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
          <div class="emoji-picker-grid">
            {matches.map((e) => (
              <button key={e.code} type="button" class="emoji-picker-item" title={`:${e.code}:`} aria-label={`React with ${e.char}`} onClick={pick(e.char)}>
                {e.char}
              </button>
            ))}
            {matches.length === 0 && <div class="emoji-picker-empty">No match</div>}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
