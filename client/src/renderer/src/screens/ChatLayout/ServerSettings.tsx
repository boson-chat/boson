import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Badge, Button, Card, ChipInput, Divider, Field, Input, Toggle } from '@boson/shared';
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

type SectionId = 'info' | 'identity' | 'edit' | 'actions' | 'log';

// Snapshot of the editable profile fields. When the parent passes
// `directoryEntry`, an "Edit" tab is shown that lets the user mutate
// these fields and PATCH them back through onSaveProfile.
export interface DirectoryEntryProfile {
  serverId: string;
  name: string;
  description: string;
  tags: string[];
  languages: string[];
  isNsfw: boolean;
}

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
  // Optional — when both are present, an "Edit" tab is added that
  // lets the row's owner update profile-shaped fields and submit
  // them through onSaveProfile (which hits PATCH /servers/{id}).
  // Identity fields (hostname/port/tls) stay read-only here — they'd
  // invalidate the existing verification if mutated. The parent is
  // expected to gate this on (authed && server.registered_by === me.id).
  directoryEntry?: DirectoryEntryProfile;
  onSaveProfile?: (patch: Partial<DirectoryEntryProfile>) => Promise<void>;
}

interface MenuItem {
  id: SectionId;
  label: string;
  description: string;
}

const MENU: readonly MenuItem[] = [
  { id: 'info',     label: 'Info',     description: 'Server software + IRCv3 capabilities' },
  { id: 'identity', label: 'Identity', description: 'Your nick + NickServ login' },
  { id: 'edit',     label: 'Edit',     description: 'Directory profile — owner only' },
  { id: 'actions',  label: 'Actions',  description: 'Reconnect or disconnect' },
  { id: 'log',      label: 'Log',      description: 'Raw engine event log' },
];

export function ServerSettings({
  serverDisplayName, myNick, serverInfo, serverLog, onClearServerLog, onClose, onReconnect, onDisconnect, onChangeNick,
  directoryEntry, onSaveProfile,
}: ServerSettingsProps) {
  const [section, setSection] = useState<SectionId>('info');
  // Hide the Edit tab when the parent didn't pass ownership context.
  // Filtering at render time keeps the menu uncluttered for the 99%
  // of viewers who don't own the row.
  const editable = !!(directoryEntry && onSaveProfile);
  const visibleMenu = editable ? MENU : MENU.filter((m) => m.id !== 'edit');

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
          {visibleMenu.map((m) => (
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
          {section === 'edit' && editable && directoryEntry && onSaveProfile && (
            <EditProfileSection entry={directoryEntry} onSave={onSaveProfile} />
          )}
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

function EditProfileSection({
  entry,
  onSave,
}: {
  entry: DirectoryEntryProfile;
  onSave: (patch: Partial<DirectoryEntryProfile>) => Promise<void>;
}) {
  // Local draft owned by this component; we ONLY submit a patch with
  // the fields the user actually changed. That way submitting "rename
  // from A to B" doesn't accidentally re-send the existing tag list
  // as a fresh array (which would be a no-op but also a wasted RTT).
  const [name, setName] = useState(entry.name);
  const [description, setDescription] = useState(entry.description);
  const [tags, setTags] = useState<string[]>(entry.tags);
  const [languages, setLanguages] = useState<string[]>(entry.languages);
  const [isNsfw, setIsNsfw] = useState(entry.isNsfw);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Reset the draft whenever the canonical entry changes (e.g. the
  // backend confirmed a save and the parent rebuilt the prop).
  useEffect(() => {
    setName(entry.name);
    setDescription(entry.description);
    setTags(entry.tags);
    setLanguages(entry.languages);
    setIsNsfw(entry.isNsfw);
  }, [entry.serverId, entry.name, entry.description, entry.tags, entry.languages, entry.isNsfw]);

  const dirty =
    name !== entry.name ||
    description !== entry.description ||
    tags.join(',') !== entry.tags.join(',') ||
    languages.join(',') !== entry.languages.join(',') ||
    isNsfw !== entry.isNsfw;

  const submit = (e: Event): void => {
    e.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    const patch: Partial<DirectoryEntryProfile> = {};
    if (name !== entry.name) patch.name = name;
    if (description !== entry.description) patch.description = description;
    if (tags.join(',') !== entry.tags.join(',')) patch.tags = tags;
    if (languages.join(',') !== entry.languages.join(',')) patch.languages = languages;
    if (isNsfw !== entry.isNsfw) patch.isNsfw = isNsfw;
    onSave(patch)
      .then(() => {
        setSaved(true);
        setTimeout(() => setSaved(false), 1600);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Save failed.');
      })
      .finally(() => setBusy(false));
  };

  return (
    <SectionFrame
      title="Directory profile"
      description="Edit the public-facing fields of this server. Hostname / port / TLS are immutable — changing them would invalidate the existing TXT verification."
    >
      <Card>
        <form class="server-settings-form" onSubmit={submit}>
          <Field label="Display name" hint="What users see in the directory grid.">
            <Input
              value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              required
              autoComplete="off"
              spellcheck={false}
            />
          </Field>

          <Field label="Description" hint="One paragraph. Empty clears it.">
            <textarea
              class="server-settings-textarea"
              value={description}
              onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
              rows={3}
              spellcheck
            />
          </Field>

          <Field label="Tags" hint="Enter or comma to add a chip; × to remove.">
            <ChipInput
              value={tags}
              onChange={setTags}
              ariaLabel="Tags"
              placeholder="foss, community"
              stripHash
            />
          </Field>

          <Field label="Languages" hint="ISO codes (en, fr, ja). At least one required.">
            <ChipInput
              value={languages}
              onChange={setLanguages}
              ariaLabel="Languages"
              placeholder="en, fr"
              pattern={/^[a-z]{2}(-[a-z0-9]{2,4})?$/}
            />
          </Field>

          <Toggle
            checked={isNsfw}
            onChange={setIsNsfw}
            label="NSFW — hidden from default search"
          />

          {error && <p class="server-settings-error">{error}</p>}

          <div class="server-settings-form-actions">
            {saved && <span class="server-settings-saved">Saved</span>}
            <Button type="submit" variant="primary" disabled={!dirty || busy || languages.length === 0}>
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
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
