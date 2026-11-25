import type { ChatChannel } from '../../modules/chat';
import { SERVICE_CHANNEL } from '../../modules/chat/services';
import { applyChannelOrder, isCustomOrder } from '../../modules/session/channel-order';

// Public state surface for ChannelSidebarBloc. The view binds directly to this
// — `query`, `joinModalOpen`, `joinDraft`, `joinError` are the four bits of UI
// state that used to be `useState` cells in ChannelSidebar; `realChannels` and
// `dms` are derived from the latest channel list (read via `getChannels()`)
// filtered by the current query. We materialise the groupings inside the bloc
// so the view stays free of derivation logic.
export interface ChannelSidebarState {
  query: string;
  joinModalOpen: boolean;
  joinDraft: string;
  joinError: string | null;
  // Pre-filtered, pre-split groupings derived from props + query.
  realChannels: ChatChannel[];
  dms: ChatChannel[];
  // The synthetic `~server` pseudo-channel, when it exists. ChatService
  // routes NOTICEs from network services (NickServ etc.) and pre-reg
  // server NOTICEs here so they don't clutter the channel + DM lists.
  // Null when nothing has landed there yet.
  serverChannel: ChatChannel | null;
  // The user's saved order puts a section somewhere other than the default
  // (drives the "Reset order" menu item).
  customOrder: boolean;
}

export type ChannelSidebarListener = (state: ChannelSidebarState) => void;

export interface ChannelSidebarBlocDeps {
  // Reads always-current props via closure (the view passes a ref-backed
  // getter). The bloc never stores the channels list directly because props
  // change independently of bloc state and we don't want to plumb a setter
  // for every render.
  getChannels: () => readonly ChatChannel[];
  // The user's saved channel order (channel keys), applied within each
  // section; absent or empty keeps the default order.
  getOrder?: () => readonly string[] | undefined;
  // The default order (channel keys: the server's saved channels, in their
  // saved order). Channels it doesn't name keep the order they arrived in.
  getDefaultOrder?: () => readonly string[] | undefined;
  onJoin: (channelName: string) => void;
}

/**
 * ChannelSidebarBloc owns the filter input, join-modal lifecycle, and the
 * derived channel groupings shown in ChannelSidebar. Matches the project's
 * BLoC convention:
 *   - private state in fields
 *   - getState() returns an immutable snapshot
 *   - subscribe() emits the current state immediately and on every change
 *   - public methods are verbs the view calls
 *
 * The bloc does not hold a reference to the props.channels list — that would
 * go stale on parent re-renders. Instead it reads through `deps.getChannels`
 * (which the view backs with a ref) and the view tells the bloc when the
 * underlying list changes via {@link notifyChannelsChanged}.
 */
export class ChannelSidebarBloc {
  private query = '';
  private joinModalOpen = false;
  private joinDraft = '';
  private joinError: string | null = null;

  private readonly listeners = new Set<ChannelSidebarListener>();

  constructor(private readonly deps: ChannelSidebarBlocDeps) {}

  // Observation -----------------------------------------------------------

  getState(): ChannelSidebarState {
    // In the default order first, so a channel that joined late (it waited
    // for NickServ, say) sits where it always does.
    const channels = applyChannelOrder(this.deps.getChannels(), this.deps.getDefaultOrder?.(), (c) => c.name);
    const lower = this.query.trim().toLowerCase();
    const visibleChannels = lower
      ? channels.filter((c) => c.name.toLowerCase().includes(lower))
      : channels;

    // IRC channel names start with '#' or '&'; anything else in the chat
    // service's channel list is either the synthetic ~server pseudo-channel
    // (single, distinguished) or a virtual DM channel (e.g. a bare nick).
    const order = this.deps.getOrder?.();
    const nameOf = (c: ChatChannel): string => c.name;
    const realChannels = applyChannelOrder(visibleChannels.filter(
      (c) => c.name.startsWith('#') || c.name.startsWith('&'),
    ), order, nameOf);
    const serverChannel = visibleChannels.find((c) => c.name === SERVICE_CHANNEL) ?? null;
    const dms = applyChannelOrder(visibleChannels.filter(
      (c) => !c.name.startsWith('#') && !c.name.startsWith('&') && c.name !== SERVICE_CHANNEL,
    ), order, nameOf);
    // Judged on the unfiltered sections, so a search doesn't hide the reset.
    const isChan = (c: ChatChannel): boolean => /^[#&]/.test(c.name);
    const customOrder = !!order && order.length > 0 && (
      isCustomOrder(channels.filter(isChan), order, nameOf)
      || isCustomOrder(channels.filter((c) => !isChan(c) && c.name !== SERVICE_CHANNEL), order, nameOf));

    return {
      query: this.query,
      joinModalOpen: this.joinModalOpen,
      joinDraft: this.joinDraft,
      joinError: this.joinError,
      realChannels: [...realChannels],
      dms: [...dms],
      serverChannel,
      customOrder,
    };
  }

  subscribe(fn: ChannelSidebarListener): () => void {
    this.listeners.add(fn);
    fn(this.getState());
    return () => { this.listeners.delete(fn); };
  }

  // Commands --------------------------------------------------------------

  setQuery(value: string): void {
    if (this.query === value) return;
    this.query = value;
    this.emit();
  }

  setJoinDraft(value: string): void {
    if (this.joinDraft === value) return;
    this.joinDraft = value;
    this.emit();
  }

  openJoinModal(): void {
    this.joinDraft = '';
    this.joinError = null;
    this.joinModalOpen = true;
    this.emit();
  }

  closeJoinModal(): void {
    if (!this.joinModalOpen && this.joinDraft === '' && this.joinError === null) {
      return;
    }
    this.joinModalOpen = false;
    this.joinDraft = '';
    this.joinError = null;
    this.emit();
  }

  /**
   * Validates the current draft and, if valid, calls `onJoin` and closes
   * the modal. The error path leaves the modal open with `joinError` set so
   * the view can render the inline message. ChatService.normaliseChannel
   * auto-prefixes '#' so we accept either form once validation passes.
   */
  submitJoin(): void {
    const value = this.joinDraft.trim();
    if (!value) {
      this.joinError = 'Channel name is required.';
      this.emit();
      return;
    }
    if (/\s/.test(value)) {
      this.joinError = 'Channel names cannot contain spaces.';
      this.emit();
      return;
    }
    this.deps.onJoin(value);
    // Mirror closeJoinModal() without the early-return guard so we always
    // emit a clean post-submit snapshot.
    this.joinModalOpen = false;
    this.joinDraft = '';
    this.joinError = null;
    this.emit();
  }

  /**
   * Tell the bloc the underlying channel list (via `getChannels`) has
   * changed. Triggers a re-emit so subscribers see fresh `realChannels` /
   * `dms` groupings. The bloc itself doesn't cache the list, but it does
   * need to push a new snapshot to listeners — they otherwise have no
   * signal that derived state changed.
   */
  notifyChannelsChanged(): void {
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getState();
    this.listeners.forEach((fn) => fn(snapshot));
  }
}
