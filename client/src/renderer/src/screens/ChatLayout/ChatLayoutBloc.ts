import type { ChatService, SlashCommandSpec } from '../../modules/chat';

// Default time (ms) before the transient slash-command error banner
// auto-dismisses. Matches the pre-refactor inline constant in ChatLayout.tsx
// — kept here so the view doesn't need to know about it and tests can
// override via the deps argument.
const DEFAULT_AUTO_DISMISS_MS = 4500;

export interface ChatLayoutState {
  bannerError: string | null;
  helpCommands: readonly SlashCommandSpec[] | null;
}

export type ChatLayoutListener = (state: ChatLayoutState) => void;

export interface ChatLayoutBlocDeps {
  chat: ChatService;
  // Optional override for the auto-dismiss timer. Defaults to 4500 ms.
  autoDismissMs?: number;
}

/**
 * ChatLayoutBloc owns the transient feedback + help-modal lifecycle for
 * ChatLayout. The ChatService emits one-shot {@link ChatFeedback} events
 * from slash-command parsing — `{kind:'error'}` produces a banner that
 * auto-dismisses, `{kind:'help'}` opens a modal that the user closes
 * imperatively.
 *
 * Following the project's BLoC convention:
 *   - state lives in private fields
 *   - getState() returns the current snapshot
 *   - subscribe() fires immediately and on every change, returns an unsub
 *   - the constructor immediately wires up `chat.onFeedback(...)`; the
 *     view must call dispose() on unmount to tear the subscription down
 *     and clear any pending auto-dismiss timer
 *
 * ChatState itself remains in the view — it drives the 4-column UI and
 * rolling it in here would couple the bloc to ChatService's channel-level
 * internals for no real benefit.
 */
export class ChatLayoutBloc {
  private readonly chat: ChatService;
  private readonly autoDismissMs: number;
  private readonly listeners = new Set<ChatLayoutListener>();
  private readonly unsubscribeFeedback: () => void;
  private dismissTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private state: ChatLayoutState = {
    bannerError: null,
    helpCommands: null,
  };

  constructor(deps: ChatLayoutBlocDeps) {
    this.chat = deps.chat;
    this.autoDismissMs = deps.autoDismissMs ?? DEFAULT_AUTO_DISMISS_MS;
    // Wire up the feedback subscription immediately so the bloc is "live"
    // for the entire view lifetime. The view owns disposal via dispose().
    this.unsubscribeFeedback = this.chat.onFeedback((f) => {
      if (f.kind === 'error') {
        this.showBanner(f.text);
      } else if (f.kind === 'help') {
        this.showHelp(f.commands);
      }
    });
  }

  // Observation -----------------------------------------------------------

  getState(): ChatLayoutState {
    return this.state;
  }

  subscribe(fn: ChatLayoutListener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }

  // Commands --------------------------------------------------------------

  /**
   * Manual dismiss for the banner (the "×" button). Also clears the
   * pending auto-dismiss timer — otherwise it would fire later and emit
   * a redundant null-banner state change.
   */
  dismissBanner(): void {
    this.clearDismissTimer();
    if (this.state.bannerError === null) return;
    this.setState({ ...this.state, bannerError: null });
  }

  /** Close the help modal (× button, backdrop click, Escape). */
  closeHelp(): void {
    if (this.state.helpCommands === null) return;
    this.setState({ ...this.state, helpCommands: null });
  }

  /**
   * Tear down: unsubscribe from chat feedback and clear any pending
   * auto-dismiss timer. Safe to call twice (idempotent) so a buggy
   * unmount path can't double-unsubscribe.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeFeedback();
    this.clearDismissTimer();
  }

  // Internal --------------------------------------------------------------

  private showBanner(text: string): void {
    // Restart the auto-dismiss timer on every error — back-to-back errors
    // shouldn't cause the banner to vanish early.
    this.clearDismissTimer();
    this.dismissTimer = setTimeout(() => {
      this.dismissTimer = null;
      this.setState({ ...this.state, bannerError: null });
    }, this.autoDismissMs);
    this.setState({ ...this.state, bannerError: text });
  }

  private showHelp(commands: readonly SlashCommandSpec[]): void {
    this.setState({ ...this.state, helpCommands: commands });
  }

  private clearDismissTimer(): void {
    if (this.dismissTimer !== null) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
  }

  private setState(next: ChatLayoutState): void {
    this.state = next;
    this.listeners.forEach((fn) => fn(next));
  }
}
