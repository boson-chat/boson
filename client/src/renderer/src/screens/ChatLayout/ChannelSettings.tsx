import { useEffect, useState } from 'preact/hooks';
import { Button, Input, Tabs, Toggle } from '@boson/shared';
import type { ChatChannel } from '../../modules/chat';
import { canSetChannelMode, canSetTopic } from '../../modules/chat';
import { sameName, type ChanServController, type ChanServState, type ChannelPolicy } from '../../modules/chanserv';
import { ChannelRegistration } from './ChannelRegistration';
import './ChannelSettings.css';

// ChanServ for this connection, when the network has one.
export interface ChannelSettingsChanServ {
  ctl: ChanServController;
  state: ChanServState;
  myAccount?: string;
  policy: ChannelPolicy | null;
}

export type ChannelSettingsTab = 'channel' | 'registration';

interface ChannelSettingsProps {
  channel: ChatChannel;
  myRank: number;
  // Send a pre-composed mode fragment, e.g. '+m', '-i', '+k secret', '+l 50'.
  onSetMode: (fragment: string) => void;
  onSetTopic: (text: string) => void;
  onAddBan: (mask: string) => void;
  onRemoveBan: (mask: string) => void;
  // Re-request modes + ban list from the server (called once on open).
  onRefresh: () => void;
  chanserv?: ChannelSettingsChanServ;
  initialTab?: ChannelSettingsTab;
}

// Modes that protect a registered channel ("who can join and talk"): shown
// with its ChanServ settings when you manage it there.
const LOCK_FLAGS = ['R', 'M'];

// Boolean channel modes we expose as toggles. (List/param modes k & l have
// their own controls below; +p/+r etc. are omitted as rarely-useful here.)
const BOOL_MODES: ReadonlyArray<{ flag: string; label: string; hint?: string }> = [
  { flag: 'm', label: 'Moderated (+m)', hint: 'Only voiced (+) and above may speak' },
  { flag: 'i', label: 'Invite only (+i)', hint: 'Users must be invited to join' },
  { flag: 'R', label: 'Registered only (+R)', hint: 'Only people signed in to an account can join' },
  { flag: 'M', label: 'Registered speak (+M)', hint: 'Only people signed in to an account can talk; guests can read' },
  { flag: 't', label: 'Topic locked (+t)', hint: 'Only operators can change the topic' },
  { flag: 'n', label: 'No external messages (+n)', hint: 'Must be in the channel to message it' },
  { flag: 's', label: 'Secret (+s)', hint: 'Hide the channel from LIST / WHOIS' },
];

export function ChannelSettings({
  channel, myRank, onSetMode, onSetTopic, onAddBan, onRemoveBan, onRefresh, chanserv, initialTab = 'channel',
}: ChannelSettingsProps) {
  const canEdit = canSetChannelMode(myRank);
  const cs = chanserv?.state;
  const showRegistration = !!chanserv && !!cs?.dialect && cs.present !== false && !!cs.caps?.info;
  const [tab, setTab] = useState<ChannelSettingsTab>(initialTab);
  const activeTab: ChannelSettingsTab = showRegistration ? tab : 'channel';
  // When you manage the registered channel, its join/talk locks (and, on
  // Ergo, +t — its only topic lock) sit with the ChanServ protection options.
  const reg = chanserv?.ctl.channel(channel.name).info;
  const managesRegistration = showRegistration && !!reg?.registered && !reg.closed
    && (sameName(reg.founder, chanserv?.myAccount) || canEdit);
  const lockFlags = managesRegistration ? (cs?.dialect === 'ergo' ? [...LOCK_FLAGS, 't'] : LOCK_FLAGS) : [];
  const flags = channel.modes?.flags ?? [];
  const topicLocked = flags.includes('t');

  // Fetch fresh modes + ban list whenever the modal mounts for this channel.
  useEffect(() => { onRefresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [channel.name]);

  // Optimistic mode state: a MODE command round-trips to the server before the
  // flags update, so the switch would otherwise lag/flicker. Flip it locally on
  // click, then drop the override once the server-confirmed flags catch up (or
  // after a timeout, if the change was rejected).
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const flagsKey = flags.join(',');
  useEffect(() => {
    setOptimistic((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      const next: Record<string, boolean> = {};
      let changed = false;
      for (const f of keys) {
        if (flags.includes(f) === prev[f]) { changed = true; continue; } // confirmed → drop
        next[f] = prev[f]!;
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flagsKey]);
  const isOn = (flag: string): boolean => optimistic[flag] ?? flags.includes(flag);
  const toggleMode = (flag: string, next: boolean): void => {
    setOptimistic((p) => ({ ...p, [flag]: next }));
    onSetMode(`${next ? '+' : '-'}${flag}`);
    // Safety: if the server never echoes (rejected), re-sync to its truth.
    window.setTimeout(() => setOptimistic((p) => {
      if (!(flag in p)) return p;
      const n = { ...p }; delete n[flag]; return n;
    }), 4000);
  };

  // Local drafts for the parameterised / free-text inputs.
  const [keyDraft, setKeyDraft] = useState(channel.modes?.key ?? '');
  const [limitDraft, setLimitDraft] = useState(channel.modes?.limit != null ? String(channel.modes.limit) : '');
  const [topicDraft, setTopicDraft] = useState(channel.topic);
  const [banDraft, setBanDraft] = useState('');
  // Resync drafts when the server-side values change underneath us.
  useEffect(() => { setKeyDraft(channel.modes?.key ?? ''); }, [channel.modes?.key]);
  useEffect(() => { setLimitDraft(channel.modes?.limit != null ? String(channel.modes.limit) : ''); }, [channel.modes?.limit]);
  useEffect(() => { setTopicDraft(channel.topic); }, [channel.topic]);

  const modeRow = (m: typeof BOOL_MODES[number]) => (
    <li key={m.flag} class="chan-mode-row">
      <Toggle
        checked={isOn(m.flag)}
        disabled={!canEdit}
        label={m.label}
        onChange={(next) => toggleMode(m.flag, next)}
      />
      {m.hint && <span class="chan-mode-hint">{m.hint}</span>}
    </li>
  );

  const tabs = showRegistration && (
    <Tabs
      tabs={[{ id: 'channel', label: 'Channel' }, { id: 'registration', label: 'Registration' }]}
      active={activeTab}
      onChange={(id) => setTab(id as ChannelSettingsTab)}
    />
  );

  if (activeTab === 'registration' && chanserv) {
    return (
      <div class="chan-settings">
        {tabs}
        <ChannelRegistration
          channel={channel.name}
          ctl={chanserv.ctl}
          state={chanserv.state}
          myRank={myRank}
          myAccount={chanserv.myAccount}
          policy={chanserv.policy}
          lockToggles={lockFlags.length > 0 && (
            <ul class="chan-modes">{BOOL_MODES.filter((m) => lockFlags.includes(m.flag)).map(modeRow)}</ul>
          )}
        />
      </div>
    );
  }

  return (
    <div class="chan-settings">
      {tabs}
      {!canEdit && (
        <p class="chan-settings-note">You need channel operator (@) to change these.</p>
      )}

      <section class="chan-settings-section">
        <h4 class="chan-settings-heading">Modes</h4>
        <ul class="chan-modes">
          {BOOL_MODES.filter((m) => !lockFlags.includes(m.flag)).map(modeRow)}
        </ul>

        <div class="chan-param-row">
          <label class="chan-param-label">Key (+k)</label>
          <Input
            type="text" value={keyDraft} disabled={!canEdit} placeholder="(none)"
            onInput={(e) => setKeyDraft((e.target as HTMLInputElement).value)}
          />
          <Button variant="secondary" size="sm" disabled={!canEdit || !keyDraft.trim()} onClick={() => onSetMode(`+k ${keyDraft.trim()}`)}>Set</Button>
          <Button variant="ghost" size="sm" disabled={!canEdit || channel.modes?.key == null} onClick={() => onSetMode('-k')}>Clear</Button>
        </div>

        <div class="chan-param-row">
          <label class="chan-param-label">Limit (+l)</label>
          <Input
            type="number" min="0" value={limitDraft} disabled={!canEdit} placeholder="(none)"
            onInput={(e) => setLimitDraft((e.target as HTMLInputElement).value)}
          />
          <Button variant="secondary" size="sm" disabled={!canEdit || !/^\d+$/.test(limitDraft.trim())} onClick={() => onSetMode(`+l ${limitDraft.trim()}`)}>Set</Button>
          <Button variant="ghost" size="sm" disabled={!canEdit || channel.modes?.limit == null} onClick={() => onSetMode('-l')}>Clear</Button>
        </div>
      </section>

      <section class="chan-settings-section">
        <h4 class="chan-settings-heading">Topic</h4>
        <textarea
          class="chan-topic"
          rows={3}
          value={topicDraft}
          disabled={!canSetTopic(myRank, topicLocked)}
          onInput={(e) => setTopicDraft((e.target as HTMLTextAreaElement).value)}
        />
        <div class="chan-settings-actions">
          <Button
            size="sm"
            disabled={!canSetTopic(myRank, topicLocked) || topicDraft === channel.topic}
            onClick={() => onSetTopic(topicDraft)}
          >
            Save topic
          </Button>
        </div>
      </section>

      <section class="chan-settings-section">
        <h4 class="chan-settings-heading">Bans {channel.bans ? `(${channel.bans.length})` : ''}</h4>
        {channel.banListLoading && <p class="chan-settings-note">Loading ban list…</p>}
        {!channel.banListLoading && channel.bans && channel.bans.length === 0 && (
          <p class="chan-settings-note">No bans set.</p>
        )}
        {!!channel.bans?.length && (
          <ul class="chan-bans">
            {channel.bans.map((b) => (
              <li key={b.mask} class="chan-ban-row">
                <code class="chan-ban-mask">{b.mask}</code>
                {b.setBy && <span class="chan-ban-meta">by {b.setBy}</span>}
                <Button variant="ghost" size="sm" disabled={!canEdit} onClick={() => onRemoveBan(b.mask)}>Remove</Button>
              </li>
            ))}
          </ul>
        )}
        <div class="chan-param-row">
          <Input
            type="text" value={banDraft} disabled={!canEdit} placeholder="nick!user@host"
            onInput={(e) => setBanDraft((e.target as HTMLInputElement).value)}
          />
          <Button
            variant="secondary" size="sm"
            disabled={!canEdit || !banDraft.trim()}
            onClick={() => { onAddBan(banDraft.trim()); setBanDraft(''); }}
          >
            Add ban
          </Button>
        </div>
      </section>
    </div>
  );
}
