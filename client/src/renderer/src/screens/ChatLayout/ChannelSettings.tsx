import { useEffect, useState } from 'preact/hooks';
import type { ChatChannel } from '../../modules/chat';
import { canSetChannelMode, canSetTopic } from '../../modules/chat';
import './ChannelSettings.css';

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
}

// Boolean channel modes we expose as toggles. (List/param modes k & l have
// their own controls below; +p/+r etc. are omitted as rarely-useful here.)
const BOOL_MODES: ReadonlyArray<{ flag: string; label: string; hint?: string }> = [
  { flag: 'm', label: 'Moderated (+m)', hint: 'Only voiced (+) and above may speak' },
  { flag: 'i', label: 'Invite only (+i)', hint: 'Users must be invited to join' },
  { flag: 't', label: 'Topic locked (+t)', hint: 'Only operators can change the topic' },
  { flag: 'n', label: 'No external messages (+n)', hint: 'Must be in the channel to message it' },
  { flag: 's', label: 'Secret (+s)', hint: 'Hide the channel from LIST / WHOIS' },
];

export function ChannelSettings({
  channel, myRank, onSetMode, onSetTopic, onAddBan, onRemoveBan, onRefresh,
}: ChannelSettingsProps) {
  const canEdit = canSetChannelMode(myRank);
  const flags = channel.modes?.flags ?? [];
  const topicLocked = flags.includes('t');

  // Fetch fresh modes + ban list whenever the modal mounts for this channel.
  useEffect(() => { onRefresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [channel.name]);

  // Local drafts for the parameterised / free-text inputs.
  const [keyDraft, setKeyDraft] = useState(channel.modes?.key ?? '');
  const [limitDraft, setLimitDraft] = useState(channel.modes?.limit != null ? String(channel.modes.limit) : '');
  const [topicDraft, setTopicDraft] = useState(channel.topic);
  const [banDraft, setBanDraft] = useState('');
  // Resync drafts when the server-side values change underneath us.
  useEffect(() => { setKeyDraft(channel.modes?.key ?? ''); }, [channel.modes?.key]);
  useEffect(() => { setLimitDraft(channel.modes?.limit != null ? String(channel.modes.limit) : ''); }, [channel.modes?.limit]);
  useEffect(() => { setTopicDraft(channel.topic); }, [channel.topic]);

  return (
    <div class="chan-settings">
      {!canEdit && (
        <p class="chan-settings-note">You need channel operator (@) to change these.</p>
      )}

      <section class="chan-settings-section">
        <h4>Modes</h4>
        <ul class="chan-modes">
          {BOOL_MODES.map((m) => (
            <li key={m.flag}>
              <label class="chan-mode-toggle">
                <input
                  type="checkbox"
                  checked={flags.includes(m.flag)}
                  disabled={!canEdit}
                  onChange={(e) => onSetMode(`${(e.target as HTMLInputElement).checked ? '+' : '-'}${m.flag}`)}
                />
                <span>{m.label}</span>
              </label>
              {m.hint && <span class="chan-mode-hint">{m.hint}</span>}
            </li>
          ))}
        </ul>

        <div class="chan-param-row">
          <label>Key (+k)</label>
          <input
            type="text" value={keyDraft} disabled={!canEdit} placeholder="(none)"
            onInput={(e) => setKeyDraft((e.target as HTMLInputElement).value)}
          />
          <button type="button" disabled={!canEdit || !keyDraft.trim()} onClick={() => onSetMode(`+k ${keyDraft.trim()}`)}>Set</button>
          <button type="button" disabled={!canEdit || channel.modes?.key == null} onClick={() => onSetMode('-k')}>Clear</button>
        </div>

        <div class="chan-param-row">
          <label>Limit (+l)</label>
          <input
            type="number" min="0" value={limitDraft} disabled={!canEdit} placeholder="(none)"
            onInput={(e) => setLimitDraft((e.target as HTMLInputElement).value)}
          />
          <button type="button" disabled={!canEdit || !/^\d+$/.test(limitDraft.trim())} onClick={() => onSetMode(`+l ${limitDraft.trim()}`)}>Set</button>
          <button type="button" disabled={!canEdit || channel.modes?.limit == null} onClick={() => onSetMode('-l')}>Clear</button>
        </div>
      </section>

      <section class="chan-settings-section">
        <h4>Topic</h4>
        <textarea
          class="chan-topic"
          rows={3}
          value={topicDraft}
          disabled={!canSetTopic(myRank, topicLocked)}
          onInput={(e) => setTopicDraft((e.target as HTMLTextAreaElement).value)}
        />
        <div class="chan-settings-actions">
          <button
            type="button"
            disabled={!canSetTopic(myRank, topicLocked) || topicDraft === channel.topic}
            onClick={() => onSetTopic(topicDraft)}
          >
            Save topic
          </button>
        </div>
      </section>

      <section class="chan-settings-section">
        <h4>Bans {channel.bans ? `(${channel.bans.length})` : ''}</h4>
        {channel.banListLoading && <p class="chan-settings-note">Loading ban list…</p>}
        {!channel.banListLoading && channel.bans && channel.bans.length === 0 && (
          <p class="chan-settings-note">No bans set.</p>
        )}
        <ul class="chan-bans">
          {(channel.bans ?? []).map((b) => (
            <li key={b.mask}>
              <code>{b.mask}</code>
              {b.setBy && <span class="chan-ban-meta">by {b.setBy}</span>}
              <button type="button" class="chan-ban-remove" disabled={!canEdit} onClick={() => onRemoveBan(b.mask)}>Remove</button>
            </li>
          ))}
        </ul>
        <div class="chan-param-row">
          <input
            type="text" value={banDraft} disabled={!canEdit} placeholder="nick!user@host"
            onInput={(e) => setBanDraft((e.target as HTMLInputElement).value)}
          />
          <button
            type="button"
            disabled={!canEdit || !banDraft.trim()}
            onClick={() => { onAddBan(banDraft.trim()); setBanDraft(''); }}
          >
            Add ban
          </button>
        </div>
      </section>
    </div>
  );
}
