import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChatChannel } from '../../modules/chat';
import { Button, Input, Modal } from '@boson/shared';
import {
  ChannelSidebarBloc,
  type ChannelSidebarState,
} from './ChannelSidebarBloc';
import './ChannelSidebar.css';

interface ChannelSidebarProps {
  serverName: string;
  channels: ChatChannel[];
  activeChannel: string | null;
  onSelect: (name: string) => void;
  onJoin: (name: string) => void;
  onPart: (name: string) => void;
  // Server-advertised channel directory (from RPL_LIST). Powers the Join
  // modal's autocomplete. Optional — when absent or empty the modal still
  // works as a plain text input.
  channelDirectory?: ReadonlyArray<{ name: string; userCount: number; topic: string }>;
  // Click handler for the gear button next to the server name. Opens the
  // full-page ServerSettings view for the active server. Button is hidden
  // when not provided.
  onOpenSettings?: () => void;
}

export function ChannelSidebar({
  serverName,
  channels,
  activeChannel,
  onSelect,
  onJoin,
  onPart,
  channelDirectory,
  onOpenSettings,
}: ChannelSidebarProps) {
  // Ref-backed view of the channels prop so the bloc always reads the latest
  // list without us rebuilding it on every render. Same pattern as ChatArea
  // uses for members / knownChannels.
  const channelsRef = useRef<readonly ChatChannel[]>(channels);
  channelsRef.current = channels;
  const onJoinRef = useRef(onJoin);
  onJoinRef.current = onJoin;

  const bloc = useMemo(
    () =>
      new ChannelSidebarBloc({
        getChannels: () => channelsRef.current,
        onJoin: (name) => onJoinRef.current(name),
      }),
    [],
  );

  // When the channels prop identity changes (parent re-rendered with a new
  // list), poke the bloc so it re-derives groupings and re-emits to
  // subscribers. The bloc itself doesn't cache the list — this is just the
  // signal that derived state should refresh.
  useEffect(() => {
    bloc.notifyChannelsChanged();
  }, [channels, bloc]);

  const [state, setState] = useState<ChannelSidebarState>(() => bloc.getState());
  useEffect(() => bloc.subscribe(setState), [bloc]);

  const { joinModalOpen, joinDraft, joinError, realChannels, dms } = state;
  // The synthetic `~server` channel is intentionally not rendered here —
  // service / NickServ messages live behind the Server details modal,
  // surfaced via the version badge in the chat header.

  return (
    <aside class="channel-sidebar" aria-label="Channels">
      <div class="channel-sidebar-header">
        <div class="channel-sidebar-title sidebar-server-name">{serverName}</div>
        {onOpenSettings && (
          <button
            type="button"
            class="channel-sidebar-settings"
            aria-label="Server details"
            title="Server details"
            onClick={onOpenSettings}
          >
            <GearIcon />
          </button>
        )}
      </div>

      <div class="channel-list">
        {realChannels.length === 0 && dms.length === 0 && (
          <div class="channel-empty">No channels joined yet.</div>
        )}

        <div class="channel-section-header">
          <div class="channel-section">Channels</div>
          <button
            type="button"
            class="channel-add"
            aria-label="Add channel"
            title="Join a new channel"
            onClick={() => bloc.openJoinModal()}
          >
            +
          </button>
        </div>
        {realChannels.map((c) => (
          <ChannelRow
            key={c.name}
            channel={c}
            active={c.name === activeChannel}
            onSelect={onSelect}
            onPart={onPart}
            prefix="#"
          />
        ))}

        {dms.length > 0 && (
          <>
            <div class="channel-section-header">
              <div class="channel-section">Direct Messages</div>
            </div>
            {dms.map((c) => (
              <ChannelRow
                key={c.name}
                channel={c}
                active={c.name === activeChannel}
                onSelect={onSelect}
                onPart={onPart}
                prefix="[DM]"
              />
            ))}
          </>
        )}
      </div>

      <Modal open={joinModalOpen} onClose={() => bloc.closeJoinModal()} title="Join a channel">
        <JoinChannelBrowser
          draft={joinDraft}
          directory={channelDirectory}
          error={joinError}
          onDraftChange={(v) => bloc.setJoinDraft(v)}
          onSubmit={() => bloc.submitJoin()}
          onPick={(name) => {
            bloc.setJoinDraft(name);
            bloc.submitJoin();
          }}
          onCancel={() => bloc.closeJoinModal()}
        />
      </Modal>
    </aside>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <circle cx="6" cy="6" r="1.4" fill="none" stroke="currentColor" stroke-width="1" />
      <path
        d="M6 1 L6 2.5 M6 9.5 L6 11 M1 6 L2.5 6 M9.5 6 L11 6 M2.5 2.5 L3.5 3.5 M8.5 8.5 L9.5 9.5 M2.5 9.5 L3.5 8.5 M8.5 3.5 L9.5 2.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1"
        stroke-linecap="square"
      />
    </svg>
  );
}

interface ChannelRowProps {
  channel: ChatChannel;
  active: boolean;
  prefix: string;
  onSelect: (name: string) => void;
  onPart: (name: string) => void;
}

function ChannelRow({ channel, active, prefix, onSelect, onPart }: ChannelRowProps) {
  const display = channel.name.replace(/^[#&]/, '');
  // Unread badge: hidden when active (counters get cleared anyway) or when
  // the count is 0. `mentions` is a subset of `unread`; if any mention sits
  // unread, the badge takes the accent (amber) treatment.
  const showBadge = !active && channel.unread > 0;
  const hasMention = channel.mentions > 0;
  return (
    <div
      class={`channel-item ${active ? 'channel-item-active' : ''} ${showBadge ? 'channel-item-unread' : ''} ${hasMention ? 'channel-item-mention' : ''}`}
      onClick={() => onSelect(channel.name)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(channel.name); }}
    >
      <span class="channel-hash">{prefix}</span>
      <span class="channel-name">{channel.name.startsWith('#') ? channel.name : display}</span>
      {hasMention ? (
        <span
          class="channel-mention-count"
          aria-label={`${channel.mentions} mention${channel.mentions === 1 ? '' : 's'} in ${channel.name}`}
        >
          {channel.mentions > 99 ? '99+' : channel.mentions}
        </span>
      ) : showBadge ? (
        <span
          class="channel-unread-dot"
          aria-label={`${channel.unread} unread message${channel.unread === 1 ? '' : 's'} in ${channel.name}`}
        />
      ) : null}
      <button
        class="channel-leave"
        type="button"
        title="Leave"
        aria-label={`Leave ${channel.name}`}
        onClick={(e) => { e.stopPropagation(); onPart(channel.name); }}
      >
        ×
      </button>
    </div>
  );
}

// Search-driven channel browser shown inside the Join modal. The search box
// at the top filters the server-advertised directory (RPL_LIST) by substring
// match against channel name AND topic. Up/Down arrows move the highlight;
// Enter joins either the highlighted row or — when no row matches — the
// literal value typed (so unlisted channels are still reachable).
interface JoinChannelBrowserProps {
  draft: string;
  directory?: ReadonlyArray<{ name: string; userCount: number; topic: string }>;
  error: string | null;
  onDraftChange: (v: string) => void;
  onSubmit: () => void;
  onPick: (name: string) => void;
  onCancel: () => void;
}

const JOIN_PAGE_SIZE = 50;

function JoinChannelBrowser({
  draft, directory, error, onDraftChange, onSubmit, onPick, onCancel,
}: JoinChannelBrowserProps) {
  const [highlight, setHighlight] = useState(0);
  const [page, setPage] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const needle = draft.trim().replace(/^[#&]/, '').toLowerCase();
  const all = directory ?? [];
  // Filter the full directory by name OR topic substring. Big networks ship
  // tens of thousands of channels — the loop is cheap (one .includes() per
  // entry) and we want to paginate over the full matched set, not a cap.
  const matches = useMemo(() => {
    if (needle.length === 0) return all;
    return all.filter((c) => {
      const nameMatch = c.name.toLowerCase().replace(/^[#&]/, '').includes(needle);
      if (nameMatch) return true;
      return c.topic.toLowerCase().includes(needle);
    });
  }, [all, needle]);

  const totalPages = Math.max(1, Math.ceil(matches.length / JOIN_PAGE_SIZE));
  // Reset page + highlight when the result set changes (new query etc).
  useEffect(() => {
    setPage(0);
    setHighlight(0);
  }, [needle, all.length]);
  // Keep page in bounds if matches shrink underneath us.
  useEffect(() => {
    setPage((p) => Math.min(p, totalPages - 1));
  }, [totalPages]);

  const start = page * JOIN_PAGE_SIZE;
  const visible = matches.slice(start, start + JOIN_PAGE_SIZE);

  // Keep the highlight inside the visible page.
  useEffect(() => {
    setHighlight((h) => (visible.length === 0 ? 0 : Math.min(h, visible.length - 1)));
  }, [visible.length]);

  // Scroll the highlighted row into view as the user arrow-keys through.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(`[data-idx="${highlight}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const goPrev = (): void => {
    if (page <= 0) return;
    setPage(page - 1);
    setHighlight(0);
  };
  const goNext = (): void => {
    if (page >= totalPages - 1) return;
    setPage(page + 1);
    setHighlight(0);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (visible.length === 0) return;
      if (highlight === visible.length - 1 && page < totalPages - 1) {
        // Cross-page navigation: roll forward to the first row of next page.
        goNext();
      } else {
        setHighlight((h) => (h + 1) % visible.length);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (visible.length === 0) return;
      if (highlight === 0 && page > 0) {
        // Roll backward — land on the LAST row of the previous page.
        setPage(page - 1);
        setHighlight(JOIN_PAGE_SIZE - 1);
      } else {
        setHighlight((h) => (h - 1 + visible.length) % visible.length);
      }
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      goNext();
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      goPrev();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (visible.length > 0 && visible[highlight]) {
        onPick(visible[highlight].name);
      } else if (draft.trim()) {
        onSubmit();
      }
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  const headerLabel = directory === undefined || directory.length === 0
    ? 'Channel list not yet available — type a channel name and press Enter.'
    : needle === ''
      ? `${all.length.toLocaleString()} channels`
      : `${matches.length.toLocaleString()} match${matches.length === 1 ? '' : 'es'} for "${needle}"`;

  return (
    <div class="channel-join-browser" onKeyDown={onKeyDown}>
      <div class="channel-join-search">
        <Input
          placeholder="Search channels by name or topic — or type #channel to join directly"
          value={draft}
          onInput={(e) => onDraftChange((e.target as HTMLInputElement).value)}
          autoFocus
          autoComplete="off"
          spellcheck={false}
        />
        {error && <div class="channel-join-error" role="alert">{error}</div>}
      </div>

      <div class="channel-join-results-head">{headerLabel}</div>

      <div class="channel-join-results" ref={listRef} role="listbox">
        {visible.length === 0 ? (
          <div class="channel-join-empty">
            {directory === undefined || directory.length === 0
              ? 'Waiting for the server to publish its channel list…'
              : 'No channels match. Press Enter to join the typed name anyway.'}
          </div>
        ) : (
          visible.map((c, idx) => (
            <button
              key={c.name}
              type="button"
              role="option"
              aria-selected={idx === highlight}
              data-idx={idx}
              class={`channel-join-result ${idx === highlight ? 'channel-join-result-active' : ''}`}
              onClick={() => onPick(c.name)}
              onMouseEnter={() => setHighlight(idx)}
              title={c.topic || c.name}
            >
              <span class="channel-join-result-name">{c.name}</span>
              <span class="channel-join-result-users">
                {c.userCount.toLocaleString()} {c.userCount === 1 ? 'user' : 'users'}
              </span>
              {c.topic && (
                <span class="channel-join-result-topic">{c.topic}</span>
              )}
            </button>
          ))
        )}
      </div>

      {totalPages > 1 && (
        <div class="channel-join-pagination" aria-label="Channel list pagination">
          <button
            type="button"
            class="channel-join-page-btn"
            onClick={goPrev}
            disabled={page === 0}
            aria-label="Previous page"
          >
            ‹ Prev
          </button>
          <span class="channel-join-page-status">
            Page {page + 1} of {totalPages.toLocaleString()}
            <span class="channel-join-page-range">
              {' '}({(start + 1).toLocaleString()}–{Math.min(start + JOIN_PAGE_SIZE, matches.length).toLocaleString()} of {matches.length.toLocaleString()})
            </span>
          </span>
          <button
            type="button"
            class="channel-join-page-btn"
            onClick={goNext}
            disabled={page >= totalPages - 1}
            aria-label="Next page"
          >
            Next ›
          </button>
        </div>
      )}

      <div class="channel-join-actions">
        <Button variant="ghost" type="button" onClick={onCancel}>Cancel</Button>
        <Button
          variant="primary"
          type="button"
          disabled={!draft.trim() && visible.length === 0}
          onClick={() => {
            if (visible.length > 0 && visible[highlight]) onPick(visible[highlight].name);
            else if (draft.trim()) onSubmit();
          }}
        >
          {visible.length > 0 ? `Join ${visible[highlight]?.name ?? ''}` : 'Join'}
        </Button>
      </div>
    </div>
  );
}
