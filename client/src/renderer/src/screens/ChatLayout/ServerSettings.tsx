import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Badge, Button, Card, Divider, Field, Input } from '@boson/shared';
import type { ServerInfo, ServerLogEntry } from '../../modules/chat';
import './ServerSettings.css';

// Server settings screen. Renders to the right of the persistent ServerRail
// (the user can still switch servers). Internally split into:
//   - left menu: section nav (Info / Identity / Actions / Log)
//   - body: content for the active section
//
// Sections:
//   - Info     : read-only network metadata (version, hostname, IRCv3 caps)
//   - Identity : current nick + how-to hint for NickServ identification
//   - Actions  : Reconnect / Disconnect
//   - Log      : every raw IRC event the engine forwarded for this connection
//
// Deliberately not a chat-style log — see the Log section for the dev-tools
// view of NickServ replies + CAP frames + numerics.

type SectionId = 'info' | 'identity' | 'actions' | 'log';

interface ServerSettingsProps {
  serverDisplayName: string;
  myNick: string;
  serverInfo: ServerInfo;
  serverLog: ReadonlyArray<ServerLogEntry>;
  onClearServerLog: () => void;
  onClose: () => void;
  onReconnect?: () => void;
  onDisconnect?: () => void;
  // Optional — when present, the Identity section renders an inline
  // "Change nick" form that calls into ChatService.changeNick. Wired
  // through the bloc rather than directly to the engine so the same
  // path the /nick slash command uses also drives the button.
  onChangeNick?: (nick: string) => void;
}

interface MenuItem {
  id: SectionId;
  label: string;
  description: string;
}

const MENU: readonly MenuItem[] = [
  { id: 'info',     label: 'Info',     description: 'Server software + IRCv3 capabilities' },
  { id: 'identity', label: 'Identity', description: 'Your nick + NickServ login' },
  { id: 'actions',  label: 'Actions',  description: 'Reconnect or disconnect' },
  { id: 'log',      label: 'Log',      description: 'Raw engine event log' },
];

export function ServerSettings({
  serverDisplayName, myNick, serverInfo, serverLog, onClearServerLog, onClose, onReconnect, onDisconnect, onChangeNick,
}: ServerSettingsProps) {
  const [section, setSection] = useState<SectionId>('info');

  return (
    <main class="server-settings">
      <header class="server-settings-header">
        <div class="server-settings-header-left">
          <span class="server-settings-eyebrow">Server settings</span>
          <h1 class="server-settings-title">{serverDisplayName}</h1>
        </div>
        <button
          type="button"
          class="server-settings-close"
          onClick={onClose}
          aria-label="Close settings"
          title="Back to chat"
        >
          ×
        </button>
      </header>

      <div class="server-settings-split">
        <nav class="server-settings-menu" aria-label="Settings sections">
          {MENU.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={section === m.id}
              class={`server-settings-menu-item ${section === m.id ? 'server-settings-menu-item-active' : ''}`}
              onClick={() => setSection(m.id)}
            >
              <span class="server-settings-menu-label">{m.label}</span>
              <span class="server-settings-menu-desc">{m.description}</span>
            </button>
          ))}
        </nav>

        <div class="server-settings-body" role="tabpanel">
          {section === 'info' && <InfoSection info={serverInfo} />}
          {section === 'identity' && <IdentitySection myNick={myNick} onChangeNick={onChangeNick} />}
          {section === 'actions' && <ActionsSection onReconnect={onReconnect} onDisconnect={onDisconnect} />}
          {section === 'log' && <LogSection entries={serverLog} onClear={onClearServerLog} />}
        </div>
      </div>
    </main>
  );
}

function InfoSection({ info }: { info: ServerInfo }) {
  const { serverName, version, network, enabledCaps } = info;
  const caps = enabledCaps ?? [];
  return (
    <SectionFrame
      title="Info"
      description="What the server told us during the IRCv3 capability handshake."
    >
      <Card>
        <div class="server-settings-card-body">
          <DetailRow label="Hostname" value={serverName} />
          <Divider />
          <DetailRow label="Version" value={version} />
          <Divider />
          <DetailRow label="Network" value={network} />
          <Divider />
          <DetailRow
            label="IRCv3 caps"
            customValue={
              caps.length === 0
                ? <span class="server-settings-empty">none ACKed yet</span>
                : (
                  <div class="server-settings-caps">
                    {caps.map((c) => <Badge key={c} tone="info">{c}</Badge>)}
                  </div>
                )
            }
          />
        </div>
      </Card>
    </SectionFrame>
  );
}

function IdentitySection({ myNick, onChangeNick }: { myNick: string; onChangeNick?: (nick: string) => void }) {
  // Optimistic input: we update the local draft as the user types, and
  // submit dispatches through onChangeNick. The actual rename only
  // applies when the server echoes a NICK event — which the bloc
  // handles globally — so this form intentionally doesn't update the
  // visible "Nick" row directly. If the server rejects (433 in-use,
  // 432 bad), the chat service surfaces an error banner.
  const [draft, setDraft] = useState(myNick);
  const submit = (e: Event): void => {
    e.preventDefault();
    const next = draft.trim();
    if (!onChangeNick || !next || next === myNick) return;
    onChangeNick(next);
  };
  // Keep the draft in sync when the server's authoritative nick
  // changes (e.g. NICK echo after success, or NickServ-driven rename).
  useEffect(() => { setDraft(myNick); }, [myNick]);
  return (
    <SectionFrame
      title="Identity"
      description="Your IRC identity on this network. NickServ replies appear in the Log section."
    >
      <Card>
        <div class="server-settings-card-body">
          <DetailRow label="Nick" value={myNick} />
          {onChangeNick && (
            <>
              <Divider />
              <form class="server-settings-nick-form" onSubmit={submit}>
                <Field
                  label="Change nick"
                  hint="Server may reject duplicates or invalid characters; you'll see an error banner if it does."
                >
                  <Input
                    value={draft}
                    onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
                    autoComplete="off"
                    spellcheck={false}
                  />
                </Field>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!draft.trim() || draft.trim() === myNick}
                >
                  Save
                </Button>
              </form>
            </>
          )}
          <Divider />
          <DetailRow
            label="NickServ"
            customValue={
              <div class="server-settings-hint">
                <div>
                  To claim a registered nick, message <code class="server-settings-code">NickServ</code> directly from any channel:
                </div>
                <code class="server-settings-code-block">
                  /msg NickServ identify &lt;your-password&gt;
                </code>
                <div class="server-settings-hint-muted">
                  A dedicated identify form is planned.
                </div>
              </div>
            }
          />
        </div>
      </Card>
    </SectionFrame>
  );
}

function ActionsSection({ onReconnect, onDisconnect }: { onReconnect?: () => void; onDisconnect?: () => void }) {
  return (
    <SectionFrame
      title="Actions"
      description="Connection lifecycle. Disconnect removes this server from your saved set; reconnect rebuilds the IRC session."
    >
      <div class="server-settings-actions">
        {onReconnect && (
          <Button variant="secondary" onClick={onReconnect}>Reconnect</Button>
        )}
        {onDisconnect && (
          <Button variant="ghost" onClick={onDisconnect}>Disconnect from server</Button>
        )}
      </div>
    </SectionFrame>
  );
}

function LogSection({ entries, onClear }: { entries: ReadonlyArray<ServerLogEntry>; onClear: () => void }) {
  return (
    <SectionFrame
      title="Engine log"
      description="Every raw IRC event the engine forwarded for this connection. Useful for auditing NickServ exchanges, CAP negotiation, server numerics, etc."
    >
      <Card>
        <div class="server-settings-log">
          <div class="server-settings-log-head">
            <span class="server-settings-log-count">
              {entries.length === 0 ? 'No entries yet.' : `${entries.length} entries`}
            </span>
            <Button
              variant="ghost"
              disabled={entries.length === 0}
              onClick={onClear}
            >
              Clear
            </Button>
          </div>
          {entries.length > 0 && (
            <div class="server-settings-log-body">
              {entries.map((e) => (
                <div key={e.id} class="server-settings-log-row">
                  <span class="server-settings-log-kind">{e.kind}</span>
                  <span class="server-settings-log-from">{e.from || '—'}</span>
                  <span class="server-settings-log-target">{e.target || '—'}</span>
                  <span class="server-settings-log-message">{e.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </SectionFrame>
  );
}

interface SectionFrameProps {
  title: string;
  description?: string;
  children: ComponentChildren;
}

function SectionFrame({ title, description, children }: SectionFrameProps) {
  return (
    <section class="server-settings-section">
      <div class="server-settings-section-head">
        <h2 class="server-settings-section-title">{title}</h2>
        {description && <p class="server-settings-section-desc">{description}</p>}
      </div>
      <div class="server-settings-section-body">{children}</div>
    </section>
  );
}

interface DetailRowProps {
  label: string;
  value?: string | null;
  customValue?: ComponentChildren;
}

function DetailRow({ label, value, customValue }: DetailRowProps) {
  return (
    <div class="server-settings-row">
      <dt class="server-settings-label">{label}</dt>
      <dd class="server-settings-value">
        {customValue ?? (
          value
            ? <span>{value}</span>
            : <span class="server-settings-empty">unknown</span>
        )}
      </dd>
    </div>
  );
}
