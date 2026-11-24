import { useEffect, useState } from 'preact/hooks';
import { Button, Input, ListRow, Select, SwitchRow, Tabs } from '@boson/shared';
import type { ChatChannel } from '../../modules/chat';
import { banMask, canSetChannelMode, canSetTopic, prefixRank } from '../../modules/chat';
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
  // Our own nick here (not offered as someone to ban).
  myNick?: string;
}

// Modes that protect a registered channel ("who can join and talk"): shown
// with its ChanServ settings when you manage it there.
const LOCK_FLAGS = ['R', 'M'];

// The channel's on/off modes, in plain words and grouped by what they're
// for. The IRC letter stays out of sight (it's in the tooltip); key (+k)
// and limit (+l) have their own rows under "Who can join".
type ModeGroup = 'join' | 'talk' | 'topic' | 'visibility';
interface BoolMode { flag: string; label: string; hint: string; group: ModeGroup }
const BOOL_MODES: ReadonlyArray<BoolMode> = [
  { flag: 'i', group: 'join', label: 'Invite only', hint: 'People need an invite from an operator to join.' },
  { flag: 'R', group: 'join', label: 'Signed-in people only', hint: "Guests can't join; people need to be signed in to an account." },
  { flag: 'm', group: 'talk', label: 'Only people with a voice can talk', hint: 'Everyone else can read. Give someone a voice from the member list.' },
  { flag: 'M', group: 'talk', label: 'Only signed-in people can talk', hint: 'Guests can read but not talk.' },
  { flag: 'n', group: 'talk', label: 'Only members can post', hint: 'People must be in the channel to send it messages.' },
  { flag: 't', group: 'topic', label: 'Only operators can change the topic', hint: 'Everyone else sees it but can’t edit it.' },
  { flag: 's', group: 'visibility', label: 'Hidden channel', hint: "Not shown in the channel list or in people's profiles." },
];

/** A ban mask in words: who it stops. `detail` is the mask itself when the words aren't it. */
export function describeBan(mask: string): { who: string; detail?: string } {
  let m = /^([^!*?@]+)!\*@\*$/.exec(mask);
  if (m) return { who: m[1]!, detail: mask };
  m = /^\*!\*@([^*?]+)$/.exec(mask);
  if (m) return { who: `Anyone from ${m[1]}`, detail: mask };
  m = /^\$a:(.+)$/.exec(mask) ?? /^~a:(.+)$/.exec(mask);
  if (m) return { who: `Account ${m[1]}`, detail: mask };
  return { who: mask };
}

export function ChannelSettings({
  channel, myRank, onSetMode, onSetTopic, onAddBan, onRemoveBan, onRefresh, chanserv, initialTab = 'channel', myNick,
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
  // Ban by picking a member (the usual way), or by mask (Advanced).
  const [banNick, setBanNick] = useState('');
  const banCandidates = channel.members
    .filter((m) => m.nick !== myNick && prefixRank(m.prefix) < myRank)
    .sort((a, b) => a.nick.localeCompare(b.nick, undefined, { sensitivity: 'base' }));
  const banTarget = banCandidates.find((m) => m.nick === banNick);
  // Resync drafts when the server-side values change underneath us.
  useEffect(() => { setKeyDraft(channel.modes?.key ?? ''); }, [channel.modes?.key]);
  useEffect(() => { setLimitDraft(channel.modes?.limit != null ? String(channel.modes.limit) : ''); }, [channel.modes?.limit]);
  useEffect(() => { setTopicDraft(channel.topic); }, [channel.topic]);

  const modeRow = (m: BoolMode) => (
    <li key={m.flag} class="chan-mode-row" title={`IRC mode +${m.flag}`}>
      <SwitchRow
        title={m.label}
        description={m.hint}
        checked={isOn(m.flag)}
        disabled={!canEdit}
        onChange={(next) => toggleMode(m.flag, next)}
      />
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

  const group = (g: ModeGroup) => BOOL_MODES.filter((m) => m.group === g && !lockFlags.includes(m.flag)).map(modeRow);
  const talk = group('talk');
  const visibility = group('visibility');
  // Registration manages these here (its Protection options).
  const lockedHint = lockFlags.length > 0 && (
    <p class="chan-settings-note">More join and talk rules are under Registration.</p>
  );

  return (
    <div class="chan-settings">
      {tabs}
      {!canEdit && (
        <p class="chan-settings-note">You need channel operator (@) to change these.</p>
      )}

      <section class="chan-settings-section" aria-labelledby="chan-sec-topic">
        <h4 class="chan-settings-heading" id="chan-sec-topic">Topic</h4>
        <textarea
          class="chan-topic"
          rows={3}
          aria-label="Topic"
          placeholder="What's this channel about?"
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
        <ul class="chan-modes">{group('topic')}</ul>
      </section>

      <section class="chan-settings-section" aria-labelledby="chan-sec-join">
        <h4 class="chan-settings-heading" id="chan-sec-join">Who can join</h4>
        <ul class="chan-modes">{group('join')}</ul>

        <div class="chan-param-row" title="IRC mode +k">
          <label class="chan-param-label" for="chan-key">Password</label>
          <Input
            id="chan-key"
            type="text" value={keyDraft} disabled={!canEdit} placeholder="No password"
            onInput={(e) => setKeyDraft((e.target as HTMLInputElement).value)}
          />
          <Button variant="secondary" size="sm" disabled={!canEdit || !keyDraft.trim()} onClick={() => onSetMode(`+k ${keyDraft.trim()}`)}>Set</Button>
          <Button variant="ghost" size="sm" disabled={!canEdit || channel.modes?.key == null} onClick={() => onSetMode('-k')}>Clear</Button>
        </div>
        <p class="chan-settings-note chan-param-hint">People need this password to join.</p>

        <div class="chan-param-row" title="IRC mode +l">
          <label class="chan-param-label" for="chan-limit">Member limit</label>
          <Input
            id="chan-limit"
            type="number" min="0" value={limitDraft} disabled={!canEdit} placeholder="No limit"
            onInput={(e) => setLimitDraft((e.target as HTMLInputElement).value)}
          />
          <Button variant="secondary" size="sm" disabled={!canEdit || !/^\d+$/.test(limitDraft.trim())} onClick={() => onSetMode(`+l ${limitDraft.trim()}`)}>Set</Button>
          <Button variant="ghost" size="sm" disabled={!canEdit || channel.modes?.limit == null} onClick={() => onSetMode('-l')}>Clear</Button>
        </div>
        <p class="chan-settings-note chan-param-hint">At most this many people in the channel at once.</p>
      </section>

      {talk.length > 0 && (
        <section class="chan-settings-section" aria-labelledby="chan-sec-talk">
          <h4 class="chan-settings-heading" id="chan-sec-talk">Who can talk</h4>
          <ul class="chan-modes">{talk}</ul>
        </section>
      )}
      {lockedHint}

      {visibility.length > 0 && (
        <section class="chan-settings-section" aria-labelledby="chan-sec-visibility">
          <h4 class="chan-settings-heading" id="chan-sec-visibility">Visibility</h4>
          <ul class="chan-modes">{visibility}</ul>
        </section>
      )}

      <section class="chan-settings-section" aria-labelledby="chan-sec-bans">
        <h4 class="chan-settings-heading" id="chan-sec-bans">Bans {channel.bans ? `(${channel.bans.length})` : ''}</h4>
        {channel.banListLoading && <p class="chan-settings-note">Loading ban list…</p>}
        {!channel.banListLoading && channel.bans && channel.bans.length === 0 && (
          <p class="chan-settings-note">No bans set.</p>
        )}
        {!!channel.bans?.length && (
          <ul class="chan-bans">
            {channel.bans.map((b) => {
              const d = describeBan(b.mask);
              return (
                <ListRow
                  key={b.mask}
                  as="li"
                  class="chan-ban-row"
                  title={<span class="chan-ban-who">{d.who}</span>}
                  subtitle={d.detail || b.setBy ? (
                    <span class="chan-ban-sub">
                      {d.detail && <code class="chan-ban-mask">{d.detail}</code>}
                      {b.setBy && <span class="chan-ban-meta">by {b.setBy}</span>}
                    </span>
                  ) : undefined}
                  trailing={<Button variant="ghost" size="sm" disabled={!canEdit} onClick={() => onRemoveBan(b.mask)}>Remove</Button>}
                />
              );
            })}
          </ul>
        )}
        <div class="chan-param-row chan-ban-pick">
          <Select
            class="chan-ban-select"
            label="Person to ban"
            value={banTarget ? banNick : ''}
            placeholder={banCandidates.length ? 'Pick someone in the channel…' : 'No one here you can ban'}
            disabled={!canEdit || banCandidates.length === 0}
            options={banCandidates.map((m) => ({ value: m.nick, label: m.nick }))}
            onChange={(v) => setBanNick(v)}
          />
          <Button
            variant="secondary" size="sm"
            disabled={!canEdit || !banTarget}
            onClick={() => {
              if (!banTarget) return;
              onAddBan(banMask(banTarget.nick, banTarget.hostname));
              setBanNick('');
            }}
          >
            Ban
          </Button>
        </div>
        <details class="chan-ban-advanced">
          <summary class="chan-ban-advanced-summary">Ban by address (advanced)</summary>
          <div class="chan-param-row">
            <Input
              type="text" value={banDraft} disabled={!canEdit} placeholder="nick!user@host"
              aria-label="Ban mask"
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
        </details>
      </section>
    </div>
  );
}
