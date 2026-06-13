import type { SlashCommandSpec } from '../../modules/chat';
import { SLASH_COMMANDS } from '../../modules/chat';
import { stripMentionAts, tokenizeInput, type InputToken } from './chat-input.tokenize';
import { findNickWordStart, formatNickCompletion } from './chat-input.tab';

// Public state surface for ChatInputBloc. The view binds directly to this; no
// secondary state should leak into the component. Cursor placement is queued
// here (`pendingCursor`) because the controlled-textarea value updates one
// render cycle after we set it — the view applies `pendingCursor` in an
// effect on `input`, then acks via `clearPendingCursor()`.
export interface ChatInputState {
  input: string;
  // slash command popup
  slashOpen: boolean;
  slashMatches: readonly SlashCommandSpec[];
  slashSelected: number;
  // @-mention popup
  mentionOpen: boolean;
  mentionMatches: readonly string[];
  mentionSelected: number;
  mentionStartPos: number;
  // #-channel popup
  channelOpen: boolean;
  channelMatches: readonly string[];
  channelSelected: number;
  channelStartPos: number;
  // overlay tokens for the styled mirror
  tokens: readonly InputToken[];
  // pending DOM cursor position; view applies and clears it
  pendingCursor: number | null;
}

export type ChatInputListener = (state: ChatInputState) => void;

export interface ChatInputBlocDeps {
  getMembers: () => readonly { nick: string }[];
  getKnownChannels: () => readonly string[];
  onSend: (lines: string[]) => void;
  // Optional IRCv3 typing callback. The bloc fires `'active'` on each
  // non-empty input change and `'done'` on send / clear. Throttling is the
  // callee's responsibility (ChatService.sendTyping throttles internally).
  onTyping?: (state: 'active' | 'done') => void;
}

export interface KeyDownPayload {
  key: string;
  shiftKey: boolean;
  preventDefault: () => void;
  selectionStart: number | null;
}

// Nick-completion cycle. Kept in the bloc rather than the view so the view
// stays pure. Updating during keypress doesn't itself trigger a render; the
// setInput call below is what propagates.
interface NickCycle {
  prefix: string;
  matches: string[];
  index: number;
  startPos: number;
  endPos: number;
  atLineStart: boolean;
}

interface MentionCycle {
  matches: string[];
  index: number;
  startPos: number;
  endPos: number;
}

interface ChannelCycle {
  matches: string[];
  index: number;
  startPos: number;
  endPos: number;
}

interface CommandCycle {
  matches: string[];
  index: number;
  endPos: number;
}

/**
 * ChatInputBloc owns every piece of state and logic that used to live in
 * ChatArea's textarea — input string, slash/@/# popups, completion cycles
 * and the keydown reducer. The view subscribes via {@link subscribe}, reads
 * a snapshot from {@link getState}, and issues commands like
 * {@link setInput} / {@link handleKeyDown}.
 */
export class ChatInputBloc {
  private input = '';
  private slashSelected = 0;
  private slashDismissed = false;
  private mentionSelected = 0;
  private channelSelected = 0;
  private pendingCursor: number | null = null;

  private nickCycle: NickCycle | null = null;
  private mentionCycle: MentionCycle | null = null;
  private channelCycle: ChannelCycle | null = null;
  private commandCycle: CommandCycle | null = null;

  // Shell-style sent-message history. `history` is chronological (newest
  // last). `historyIndex` is the entry currently recalled, or null when the
  // user is on their live draft; `historyDraft` stashes that draft so Down
  // past the newest entry restores what they were typing. Up/Down only
  // recall when the caret is on the first/last line, so multi-line editing
  // still moves the caret normally.
  private history: string[] = [];
  private historyIndex: number | null = null;
  private historyDraft = '';
  private static readonly HISTORY_MAX = 100;

  private readonly listeners = new Set<ChatInputListener>();

  constructor(private readonly deps: ChatInputBlocDeps) {}

  // Observation -----------------------------------------------------------

  getState(): ChatInputState {
    const input = this.input;
    const slashMatches = this.computeSlashMatches(input);
    const slashOpen = slashMatches.length > 0;
    const mentionCtx = slashOpen ? null : this.computeMentionContext(input);
    const mentionOpen = mentionCtx !== null;
    const channelCtx = slashOpen || mentionOpen ? null : this.computeChannelContext(input);
    const channelOpen = channelCtx !== null;

    // Clamp selected indices to current match lengths so the view never
    // renders a stale-out-of-range highlight.
    const slashSelected = slashOpen
      ? Math.min(this.slashSelected, slashMatches.length - 1)
      : 0;
    const mentionSelected = mentionOpen
      ? Math.min(this.mentionSelected, mentionCtx!.matches.length - 1)
      : 0;
    const channelSelected = channelOpen
      ? Math.min(this.channelSelected, channelCtx!.matches.length - 1)
      : 0;

    return {
      input,
      slashOpen,
      slashMatches,
      slashSelected,
      mentionOpen,
      mentionMatches: mentionCtx?.matches ?? [],
      mentionSelected,
      mentionStartPos: mentionCtx?.startPos ?? -1,
      channelOpen,
      channelMatches: channelCtx?.matches ?? [],
      channelSelected,
      channelStartPos: channelCtx?.startPos ?? -1,
      tokens: tokenizeInput(input, this.deps.getMembers() as { nick: string }[]),
      pendingCursor: this.pendingCursor,
    };
  }

  subscribe(fn: ChatInputListener): () => void {
    this.listeners.add(fn);
    fn(this.getState());
    return () => { this.listeners.delete(fn); };
  }

  // Commands --------------------------------------------------------------

  /**
   * Replace the input buffer. Called from the textarea's onInput. Editing
   * always re-arms autocomplete (after a prior Escape dismiss) and drops
   * any in-flight cycle so the next Tab starts fresh.
   */
  setInput(value: string): void {
    const wasEmpty = this.input.length === 0;
    const isEmpty = value.length === 0;
    this.input = value;
    if (this.slashDismissed) this.slashDismissed = false;
    // Editing detaches from history browsing — the next Up starts fresh from
    // the newest entry against this edited buffer.
    this.historyIndex = null;
    this.nickCycle = null;
    this.mentionCycle = null;
    this.channelCycle = null;
    this.commandCycle = null;
    // IRCv3 typing: signal active on any non-empty keystroke; signal done
    // the first time we go from a non-empty buffer back to empty (manual
    // clear). Slash-command input is excluded — broadcasting typing tags
    // for "/help" makes no sense.
    if (this.deps.onTyping && !value.startsWith('/')) {
      if (!isEmpty) this.deps.onTyping('active');
      else if (!wasEmpty) this.deps.onTyping('done');
    }
    this.emit();
  }

  setSlashSelected(idx: number): void {
    this.slashSelected = idx;
    this.emit();
  }

  setMentionSelected(idx: number): void {
    this.mentionSelected = idx;
    this.emit();
  }

  setChannelSelected(idx: number): void {
    this.channelSelected = idx;
    this.emit();
  }

  /**
   * Mouse / Enter accept on the slash popup. Replaces the input with
   * `/<cmd> ` and queues the cursor at the end.
   */
  acceptSlash(): void {
    const matches = this.computeSlashMatches(this.input);
    if (matches.length === 0) return;
    const pick = matches[this.slashSelected] ?? matches[0]!;
    this.acceptCommand(pick);
  }

  acceptMention(): void {
    const ctx = this.computeMentionContext(this.input);
    if (!ctx) return;
    const nick = ctx.matches[this.mentionSelected] ?? ctx.matches[0]!;
    this.commitMention(ctx.startPos, nick);
  }

  acceptChannel(): void {
    const ctx = this.computeChannelContext(this.input);
    if (!ctx) return;
    const name = ctx.matches[this.channelSelected] ?? ctx.matches[0]!;
    this.commitChannel(ctx, this.channelSelected, name);
  }

  /** Escape on slash popup: hide it without clearing the input. */
  dismissSlashPopup(): void {
    this.slashDismissed = true;
    this.emit();
  }

  /**
   * Escape on @-mention popup. The popup is driven by a regex match on the
   * trailing token, so appending a space breaks the match and closes it
   * without losing user content. Matches the pre-refactor behaviour.
   */
  dismissMentionPopup(): void {
    this.input = this.input + ' ';
    this.mentionCycle = null;
    this.emit();
  }

  dismissChannelPopup(): void {
    this.input = this.input + ' ';
    this.channelCycle = null;
    this.emit();
  }

  /**
   * The big keydown reducer. Priority order, all early-returning:
   *   1. slash popup open: Tab/Up/Down/Enter/Escape
   *   2. mention popup open: same
   *   3. channel popup open: same
   *   4. no popup, Tab: advance armed cycle or do bare-nick complete
   *   5. Enter (no shift): send
   */
  handleKeyDown(e: KeyDownPayload): void {
    const slashMatches = this.computeSlashMatches(this.input);
    const slashOpen = slashMatches.length > 0;
    const mentionCtx = slashOpen ? null : this.computeMentionContext(this.input);
    const mentionOpen = mentionCtx !== null;
    const channelCtx = slashOpen || mentionOpen
      ? null
      : this.computeChannelContext(this.input);
    const channelOpen = channelCtx !== null;

    if (slashOpen) {
      this.handleSlashKey(e, slashMatches);
      return;
    }
    if (mentionOpen && mentionCtx) {
      this.handleMentionKey(e, mentionCtx);
      return;
    }
    if (channelOpen && channelCtx) {
      this.handleChannelKey(e, channelCtx);
      return;
    }
    // Sent-message history. Only recall when the caret is on the first line
    // (Up) / last line (Down) so multi-line editing still moves the caret
    // within the buffer. No popup is open here (handled above).
    if (e.key === 'ArrowUp' && this.caretOnFirstLine(e.selectionStart)) {
      if (this.recallPrevious()) { e.preventDefault(); return; }
    }
    if (e.key === 'ArrowDown' && this.caretOnLastLine(e.selectionStart)) {
      if (this.recallNext()) { e.preventDefault(); return; }
    }
    if (e.key === 'Tab') {
      // No popup open — but a previous popup may have left a cycle armed.
      // Try them in priority order, then fall back to bare-nick complete.
      if (this.advanceCommandCycle()) { e.preventDefault(); return; }
      if (this.advanceMentionCycle()) { e.preventDefault(); return; }
      if (this.advanceChannelCycle()) { e.preventDefault(); return; }
      if (this.tryNickComplete(e.selectionStart)) { e.preventDefault(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.send();
    }
  }

  // --- Sent-message history --------------------------------------------

  private caretOnFirstLine(sel: number | null): boolean {
    const s = sel ?? 0;
    // No newline anywhere before the caret ⇒ first line.
    return this.input.lastIndexOf('\n', s - 1) === -1;
  }

  private caretOnLastLine(sel: number | null): boolean {
    const s = sel ?? this.input.length;
    // No newline at/after the caret ⇒ last line.
    return this.input.indexOf('\n', s) === -1;
  }

  /** Up arrow: step to an older entry. Returns false when there's nothing
   *  to recall (so the caller leaves the keypress to the browser). */
  private recallPrevious(): boolean {
    if (this.history.length === 0) return false;
    if (this.historyIndex === null) {
      // Entering history — stash the live draft so Down can restore it.
      this.historyDraft = this.input;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1;
    } else {
      // Already at the oldest entry — consume the key, stay put.
      return true;
    }
    this.applyHistoryEntry(this.history[this.historyIndex]!);
    return true;
  }

  /** Down arrow: step to a newer entry, or restore the live draft once we
   *  move past the newest. Returns false when not browsing. */
  private recallNext(): boolean {
    if (this.historyIndex === null) return false;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex += 1;
      this.applyHistoryEntry(this.history[this.historyIndex]!);
    } else {
      this.historyIndex = null;
      this.input = this.historyDraft;
      this.historyDraft = '';
      this.pendingCursor = this.input.length;
      this.resetCompletionState();
      this.emit();
    }
    return true;
  }

  private applyHistoryEntry(entry: string): void {
    this.input = entry;
    this.pendingCursor = entry.length; // caret to end
    this.resetCompletionState();
    this.emit();
  }

  private resetCompletionState(): void {
    this.slashDismissed = false;
    this.nickCycle = null;
    this.mentionCycle = null;
    this.channelCycle = null;
    this.commandCycle = null;
  }

  clearPendingCursor(): void {
    if (this.pendingCursor === null) return;
    this.pendingCursor = null;
    this.emit();
  }

  /** Used by the Send button. */
  send(): void {
    const text = this.input.trim();
    if (!text) return;
    // Record the exact buffer (multi-line preserved) for Up-arrow recall,
    // skipping consecutive duplicates and capping the ring.
    const submitted = this.input;
    if (this.history[this.history.length - 1] !== submitted) {
      this.history.push(submitted);
      if (this.history.length > ChatInputBloc.HISTORY_MAX) this.history.shift();
    }
    this.historyIndex = null;
    this.historyDraft = '';
    // IRC PRIVMSG is one line per command. Multi-line input becomes N
    // PRIVMSGs; receivers see them grouped (same sender, same window).
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const members = this.deps.getMembers() as { nick: string }[];
    const stripped = lines.map((l) => stripMentionAts(l, members));
    this.deps.onSend(stripped);
    // Hitting Send is an explicit stop — clear our typing indicator before
    // the message actually goes out so receivers don't see a phantom
    // "still typing" for the throttle window.
    this.deps.onTyping?.('done');
    this.input = '';
    this.slashDismissed = false;
    this.nickCycle = null;
    this.mentionCycle = null;
    this.channelCycle = null;
    this.commandCycle = null;
    this.emit();
  }

  // Internal: popup keydown branches ------------------------------------

  private handleSlashKey(e: KeyDownPayload, matches: readonly SlashCommandSpec[]): void {
    if (e.key === 'Tab') {
      e.preventDefault();
      this.beginCommandCycle(matches);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.slashSelected = (this.slashSelected + 1) % matches.length;
      this.emit();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.slashSelected =
        (this.slashSelected - 1 + matches.length) % matches.length;
      this.emit();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const pick = matches[this.slashSelected] ?? matches[0]!;
      this.acceptCommand(pick);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.dismissSlashPopup();
      return;
    }
  }

  private handleMentionKey(
    e: KeyDownPayload,
    ctx: { startPos: number; matches: string[] },
  ): void {
    if (e.key === 'Tab') {
      e.preventDefault();
      this.beginMentionCycle(ctx);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.mentionSelected = (this.mentionSelected + 1) % ctx.matches.length;
      this.emit();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.mentionSelected =
        (this.mentionSelected - 1 + ctx.matches.length) % ctx.matches.length;
      this.emit();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const pick = ctx.matches[this.mentionSelected] ?? ctx.matches[0]!;
      this.commitMention(ctx.startPos, pick);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.dismissMentionPopup();
      return;
    }
  }

  private handleChannelKey(
    e: KeyDownPayload,
    ctx: { startPos: number; matches: string[] },
  ): void {
    if (e.key === 'Tab') {
      e.preventDefault();
      this.beginChannelCycle(ctx);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.channelSelected = (this.channelSelected + 1) % ctx.matches.length;
      this.emit();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.channelSelected =
        (this.channelSelected - 1 + ctx.matches.length) % ctx.matches.length;
      this.emit();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const pick = ctx.matches[this.channelSelected] ?? ctx.matches[0]!;
      this.commitChannel(ctx, this.channelSelected, pick);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.dismissChannelPopup();
      return;
    }
  }

  // Internal: completion helpers ----------------------------------------

  private acceptCommand(cmd: SlashCommandSpec): void {
    const completed = `/${cmd.name} `;
    this.input = completed;
    this.pendingCursor = completed.length;
    this.slashSelected = 0;
    this.slashDismissed = false;
    this.nickCycle = null;
    this.mentionCycle = null;
    this.channelCycle = null;
    this.commandCycle = null;
    this.emit();
  }

  private beginCommandCycle(matches: readonly SlashCommandSpec[]): void {
    if (matches.length === 0) return;
    const idx = Math.min(this.slashSelected, matches.length - 1);
    const name = matches[idx]!.name;
    const completion = `/${name} `;
    this.commandCycle = {
      matches: matches.map((c) => c.name),
      index: idx,
      endPos: completion.length,
    };
    this.input = completion;
    this.pendingCursor = completion.length;
    this.slashSelected = 0;
    this.slashDismissed = false;
    this.emit();
  }

  private advanceCommandCycle(): boolean {
    const cur = this.commandCycle;
    if (!cur) return false;
    if (cur.matches.length <= 1) return true; // consume Tab but no-op
    const nextIdx = (cur.index + 1) % cur.matches.length;
    const completion = `/${cur.matches[nextIdx]} `;
    this.commandCycle = { ...cur, index: nextIdx, endPos: completion.length };
    this.input = completion;
    this.pendingCursor = completion.length;
    this.emit();
    return true;
  }

  private commitMention(startPos: number, nick: string): void {
    const before = this.input.slice(0, startPos);
    const completed = `${before}@${nick} `;
    this.input = completed;
    this.pendingCursor = completed.length;
    this.mentionSelected = 0;
    this.nickCycle = null;
    this.channelCycle = null;
    this.commandCycle = null;
    this.emit();
  }

  private beginMentionCycle(ctx: { startPos: number; matches: string[] }): void {
    const idx = Math.min(this.mentionSelected, ctx.matches.length - 1);
    const completion = `@${ctx.matches[idx]} `;
    const before = this.input.slice(0, ctx.startPos);
    const nextValue = before + completion;
    const endPos = ctx.startPos + completion.length;
    this.mentionCycle = {
      matches: ctx.matches,
      index: idx,
      startPos: ctx.startPos,
      endPos,
    };
    this.input = nextValue;
    this.pendingCursor = endPos;
    this.emit();
  }

  private advanceMentionCycle(): boolean {
    const cur = this.mentionCycle;
    if (!cur) return false;
    if (cur.matches.length <= 1) return true;
    const nextIdx = (cur.index + 1) % cur.matches.length;
    const completion = `@${cur.matches[nextIdx]} `;
    const before = this.input.slice(0, cur.startPos);
    const after = this.input.slice(cur.endPos);
    const nextValue = before + completion + after;
    const endPos = cur.startPos + completion.length;
    this.mentionCycle = { ...cur, index: nextIdx, endPos };
    this.input = nextValue;
    this.pendingCursor = endPos;
    this.emit();
    return true;
  }

  // commitChannel handles both the popup mouse-click path and Enter-accept.
  // It arms the channel cycle so subsequent Tabs (with the popup now closed
  // because of the trailing space) keep swapping matches.
  private commitChannel(
    ctx: { startPos: number; matches: string[] },
    idx: number,
    name: string,
  ): void {
    const before = this.input.slice(0, ctx.startPos);
    const completion = `${name} `;
    const endPos = ctx.startPos + completion.length;
    this.channelCycle = {
      matches: ctx.matches,
      index: Math.min(idx, ctx.matches.length - 1),
      startPos: ctx.startPos,
      endPos,
    };
    this.input = before + completion;
    this.pendingCursor = endPos;
    this.channelSelected = 0;
    this.nickCycle = null;
    this.mentionCycle = null;
    this.commandCycle = null;
    this.emit();
  }

  private beginChannelCycle(ctx: { startPos: number; matches: string[] }): void {
    const idx = Math.min(this.channelSelected, ctx.matches.length - 1);
    const completion = `${ctx.matches[idx]} `;
    const before = this.input.slice(0, ctx.startPos);
    const endPos = ctx.startPos + completion.length;
    this.channelCycle = {
      matches: ctx.matches,
      index: idx,
      startPos: ctx.startPos,
      endPos,
    };
    this.input = before + completion;
    this.pendingCursor = endPos;
    this.emit();
  }

  private advanceChannelCycle(): boolean {
    const cur = this.channelCycle;
    if (!cur) return false;
    if (cur.matches.length <= 1) return true;
    const nextIdx = (cur.index + 1) % cur.matches.length;
    const completion = `${cur.matches[nextIdx]} `;
    const before = this.input.slice(0, cur.startPos);
    const after = this.input.slice(cur.endPos);
    const nextValue = before + completion + after;
    const endPos = cur.startPos + completion.length;
    this.channelCycle = { ...cur, index: nextIdx, endPos };
    this.input = nextValue;
    this.pendingCursor = endPos;
    this.emit();
    return true;
  }

  // Bare-nick Tab-complete. Looks at the word ending at the cursor and, if
  // it prefix-matches a channel member, replaces it. Subsequent Tabs cycle
  // through other matches without rescanning.
  private tryNickComplete(selectionStart: number | null): boolean {
    const members = this.deps.getMembers();
    if (members.length === 0) return false;
    const value = this.input;
    const cursor = selectionStart ?? value.length;

    const active = this.nickCycle;
    if (active && active.matches.length > 0) {
      const nextIdx = (active.index + 1) % active.matches.length;
      const completion = formatNickCompletion(
        active.matches[nextIdx]!,
        active.atLineStart,
      );
      const before = value.slice(0, active.startPos);
      const after = value.slice(active.endPos);
      const nextValue = before + completion + after;
      this.input = nextValue;
      this.pendingCursor = active.startPos + completion.length;
      this.nickCycle = {
        ...active,
        index: nextIdx,
        endPos: active.startPos + completion.length,
      };
      this.emit();
      return true;
    }

    const wordStart = findNickWordStart(value, cursor);
    if (wordStart === cursor) return false;
    const prefix = value.slice(wordStart, cursor);
    if (!prefix) return false;
    const lower = prefix.toLowerCase();
    const matches = members
      .filter((m) => m.nick.toLowerCase().startsWith(lower))
      .map((m) => m.nick)
      .sort((a, b) => a.localeCompare(b));
    if (matches.length === 0) return false;

    const atLineStart = wordStart === 0;
    const completion = formatNickCompletion(matches[0]!, atLineStart);
    const nextValue = value.slice(0, wordStart) + completion + value.slice(cursor);
    this.input = nextValue;
    this.pendingCursor = wordStart + completion.length;
    this.nickCycle = {
      prefix,
      matches,
      index: 0,
      startPos: wordStart,
      endPos: wordStart + completion.length,
      atLineStart,
    };
    this.emit();
    return true;
  }

  // Context computations: pure functions over (input, deps). Kept private
  // so the view can't accidentally compute popup state out-of-sync with
  // the bloc — getState() is the single source of truth.

  private computeSlashMatches(input: string): readonly SlashCommandSpec[] {
    if (this.slashDismissed) return [];
    if (!input.startsWith('/') || input.startsWith('//')) return [];
    if (input.indexOf(' ') !== -1) return [];
    const query = input.slice(1).toLowerCase();
    return SLASH_COMMANDS.filter((c) => {
      if (c.name.startsWith(query)) return true;
      return (c.aliases ?? []).some((a) => a.startsWith(query));
    });
  }

  private computeMentionContext(
    input: string,
  ): { startPos: number; prefix: string; matches: string[] } | null {
    const members = this.deps.getMembers();
    if (members.length === 0) return null;
    const m = /(^|\s)@([A-Za-z0-9_\-[\]\\{}|^`]*)$/.exec(input);
    if (!m) return null;
    const lead = m[1] ?? '';
    const partial = m[2] ?? '';
    const startPos = m.index + lead.length;
    const lower = partial.toLowerCase();
    const matches = members
      .filter((member) => member.nick.toLowerCase().startsWith(lower))
      .map((member) => member.nick)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 8);
    if (matches.length === 0) return null;
    return { startPos, prefix: partial, matches };
  }

  private computeChannelContext(
    input: string,
  ): { startPos: number; prefix: string; matches: string[] } | null {
    const knownChannels = this.deps.getKnownChannels();
    if (knownChannels.length === 0) return null;
    const m = /(^|\s)([#&])([A-Za-z0-9_\-[\]\\{}|^`]*)$/.exec(input);
    if (!m) return null;
    const lead = m[1] ?? '';
    const sigil = m[2] ?? '#';
    const partial = m[3] ?? '';
    const startPos = m.index + lead.length;
    const lower = (sigil + partial).toLowerCase();
    const matches = knownChannels
      .filter((name) => name.toLowerCase().startsWith(lower))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 8);
    if (matches.length === 0) return null;
    return { startPos, prefix: sigil + partial, matches };
  }

  private emit(): void {
    const state = this.getState();
    this.listeners.forEach((fn) => fn(state));
  }
}
