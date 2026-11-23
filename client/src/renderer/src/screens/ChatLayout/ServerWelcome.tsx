import { Button, ListRow } from '@boson/shared';
import { stripIrcFormatting } from './markdown';
import './ServerWelcome.css';

export interface WelcomeChannel {
  name: string;
  userCount?: number;
  topic?: string;
}

// How many channels the welcome suggests.
const WELCOME_CHANNELS = 6;

/**
 * The channels to suggest on a server you're in no channel of: the ones the
 * listing names (its default ones first), then the busiest of the server's
 * own channel list (RPL_LIST).
 */
export function welcomeChannels(
  listed: readonly string[],
  directory: ReadonlyArray<{ name: string; userCount: number; topic: string }>,
  max = WELCOME_CHANNELS,
): WelcomeChannel[] {
  const byName = new Map(directory.map((c) => [c.name.toLowerCase(), c]));
  const out: WelcomeChannel[] = [];
  const seen = new Set<string>();
  const add = (c: WelcomeChannel): void => {
    const k = c.name.toLowerCase();
    if (seen.has(k) || out.length >= max) return;
    seen.add(k);
    out.push(c);
  };
  for (const name of listed) {
    const d = byName.get(name.toLowerCase());
    add(d ? { name: d.name, userCount: d.userCount, topic: stripIrcFormatting(d.topic).trim() } : { name });
  }
  for (const d of [...directory].sort((a, b) => b.userCount - a.userCount)) add({ name: d.name, userCount: d.userCount, topic: stripIrcFormatting(d.topic).trim() });
  return out;
}

// What a server shows before you're in any of its channels: what it is,
// and where to go — its popular channels, each one click from joined, and
// the full channel browser. Instead of an empty room.
export function ServerWelcome({ serverName, description, channels, onJoin, onBrowse }: {
  serverName: string;
  description?: string;
  channels: readonly WelcomeChannel[];
  onJoin: (name: string) => void;
  onBrowse?: () => void;
}) {
  return (
    <section class="server-welcome" aria-label={`Welcome to ${serverName}`}>
      <h2 class="server-welcome-title">Welcome to {serverName}</h2>
      {description && <p class="server-welcome-desc">{description}</p>}
      {channels.length > 0 ? (
        <>
          <h3 class="server-welcome-heading">Popular channels</h3>
          <div class="server-welcome-channels" role="list">
            {channels.map((c) => (
              <ListRow
                key={c.name}
                class="server-welcome-channel"
                rowProps={{ role: 'listitem' }}
                title={c.name}
                subtitle={[
                  typeof c.userCount === 'number' ? `${c.userCount.toLocaleString()} ${c.userCount === 1 ? 'person' : 'people'}` : '',
                  c.topic ?? '',
                ].filter(Boolean).join(' · ') || undefined}
                trailing={(
                  <Button variant="secondary" size="sm" onClick={() => onJoin(c.name)} aria-label={`Join ${c.name}`}>Join</Button>
                )}
              />
            ))}
          </div>
        </>
      ) : (
        <p class="server-welcome-desc">Pick a channel to start chatting.</p>
      )}
      {onBrowse && (
        <Button variant={channels.length > 0 ? 'ghost' : 'primary'} class="server-welcome-browse" onClick={onBrowse}>
          Browse all channels
        </Button>
      )}
    </section>
  );
}
