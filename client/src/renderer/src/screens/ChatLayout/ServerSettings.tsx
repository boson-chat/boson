import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Badge, Button, Card, ChipInput, Divider, Field, Input, Tabs, Toggle, useTransientFlag } from '@boson/shared';
import type { ServerInfo, ServerLogEntry } from '../../modules/chat';
import { getServiceCredentialsStore } from '../../modules/chat/services-credentials';
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

type SectionId = 'info' | 'identity' | 'advanced' | 'edit' | 'actions' | 'log';

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
  // ---- Advanced section -----------------------------------------------
  // Stable id for this connection — used as the lookup key for the
  // services-credentials store (per-server NickServ password, etc.).
  // Omit when the parent doesn't have a stable id (e.g., a cold-start
  // SavedServer snapshot); the Advanced section degrades to a read-only
  // notice in that case.
  serverId?: string;
  // Detected services package on this connection. Drives the Advanced
  // panel to show atheme- vs anope-specific command surfaces. Null
  // when no service traffic has been observed yet on the session.
  servicesFramework?: 'atheme' | 'anope' | 'ergo' | 'unknown' | null;
  // Fire NickServ IDENTIFY with the stored password. Surfaced so the
  // user can re-run auto-identify right after saving a password
  // without needing to reconnect.
  onTriggerAutoIdentify?: () => void;
  // Send an arbitrary IRC slash-command line (e.g. `/whois foo`) — used
  // by the Advanced panel's command forms so we go through the same
  // input pipeline as the chat box for parity (slash parsing, help
  // commands, feedback banner, etc.).
  onRunCommand?: (line: string) => void;
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
  { id: 'advanced', label: 'Advanced', description: 'IRC + services command UI' },
];

export function ServerSettings({
  serverDisplayName, myNick, serverInfo, serverLog, onClearServerLog, onClose, onReconnect, onDisconnect, onChangeNick,
  serverId, servicesFramework = null, onTriggerAutoIdentify, onRunCommand,
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
          {section === 'advanced' && (
            <AdvancedSection
              serverId={serverId}
              servicesFramework={servicesFramework}
              myNick={myNick}
              onTriggerAutoIdentify={onTriggerAutoIdentify}
              onRunCommand={onRunCommand}
              serverLog={serverLog}
            />
          )}
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
  const [saved, triggerSaved] = useTransientFlag(1600);

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
        triggerSaved();
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

// Maps the detected services-framework enum to a human label for the UI.
// `unknown` means we've seen service traffic but couldn't pin down the
// package — common shorthand for "talks to NickServ but doesn't say its
// name in any banner". `null` is the pre-observation state (e.g., the
// user just connected and no service has spoken yet).
function frameworkLabel(fw: 'atheme' | 'anope' | 'ergo' | 'unknown' | null): string {
  if (fw === 'atheme') return 'Atheme';
  if (fw === 'anope') return 'Anope';
  if (fw === 'ergo') return 'Ergo (built-in)';
  if (fw === 'unknown') return 'Detected (unknown package)';
  return 'Not detected';
}

interface AdvancedSectionProps {
  serverId?: string;
  servicesFramework: 'atheme' | 'anope' | 'ergo' | 'unknown' | null;
  myNick: string;
  onTriggerAutoIdentify?: () => void;
  onRunCommand?: (line: string) => void;
  // Live server-log buffer from ChatService. Each command row uses this
  // to capture and display the server's reply inline (services NOTICEs,
  // numeric replies, etc.) without having to flip to the ~server channel.
  serverLog: ReadonlyArray<ServerLogEntry>;
}

// "Advanced" — first cut: services management (NickServ identify with
// stored credentials) plus a small IRC commands surface (currently just
// `/whois`). Designed to grow: each command lives in its own SubCard
// so adding ChanServ, user-modes, etc. is just another card below.
type AdvancedTabId =
  | 'services'
  | 'nickserv'
  | 'account'
  | 'lookups'
  | 'chanserv'
  | 'modes'
  | 'server'
  | 'memos'
  | 'cloak';

const ADVANCED_TABS: ReadonlyArray<{ id: AdvancedTabId; label: string }> = [
  { id: 'services', label: 'Services' },
  { id: 'nickserv', label: 'NickServ' },
  { id: 'account',  label: 'Account'  },
  { id: 'lookups',  label: 'Lookups'  },
  { id: 'chanserv', label: 'ChanServ' },
  { id: 'modes',    label: 'Modes'    },
  { id: 'server',   label: 'Server'   },
  { id: 'memos',    label: 'Memos'    },
  { id: 'cloak',    label: 'Cloak'    },
];

function AdvancedSection({
  serverId, servicesFramework, myNick, onTriggerAutoIdentify, onRunCommand, serverLog,
}: AdvancedSectionProps) {
  // Search filters within the active tab. When the box has any content
  // we ALSO render every other tab's subsection below (each hides
  // itself if no rows match), so a query the user typed for "kick"
  // surfaces hits no matter which tab they happened to be on. The
  // active tab still renders even when empty after filter — gives the
  // user feedback that this tab has no matches.
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<AdvancedTabId>('services');
  const subProps = { onRunCommand, serverLog, search };
  const renderTab = (id: AdvancedTabId): ComponentChildren => {
    switch (id) {
      case 'services':
        return (
          <ServicesCredentialsSubSection
            serverId={serverId}
            framework={servicesFramework}
            onTriggerAutoIdentify={onTriggerAutoIdentify}
          />
        );
      case 'nickserv': return <NickServSubSection myNick={myNick} {...subProps} />;
      case 'account':  return <AccountSubSection  myNick={myNick} {...subProps} />;
      case 'lookups':  return <LookupCommandsSubSection myNick={myNick} {...subProps} />;
      case 'chanserv': return <ChanServSubSection {...subProps} />;
      case 'modes':    return <UserModesSubSection myNick={myNick} {...subProps} />;
      case 'server':   return <ServerInfoSubSection {...subProps} />;
      case 'memos':    return <MemoServSubSection {...subProps} />;
      case 'cloak':    return <HostServSubSection {...subProps} />;
    }
  };
  return (
    <SectionFrame
      title="Advanced"
      description="IRC + services command UI. Replies show inline below each command. Raw slash commands still work in the chat input."
    >
      <div class="server-settings-advanced">
        <div class="server-settings-advanced-search">
          <Input
            value={search}
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
            placeholder="Search commands — try “whois”, “ban”, “memo”…"
            autoComplete="off"
            spellcheck={false}
          />
        </div>
        <Tabs
          tabs={ADVANCED_TABS.map((t) => ({ id: t.id, label: t.label }))}
          active={tab}
          onChange={(id) => {
            // Switching tabs clears any active search — the user has
            // navigated, so the search context no longer makes sense.
            setSearch('');
            setTab(id as AdvancedTabId);
          }}
        />
        <div class="server-settings-advanced-body">
          {search
            ? // Search active: render every tab's subsection flat. Each
              // one self-hides if no rows match — MaybeCard collapses
              // empty cards via the anyMatch index at the top.
              ADVANCED_TABS.map((t) => (
                <div key={t.id}>{renderTab(t.id)}</div>
              ))
            : renderTab(tab)}
        </div>
      </div>
    </SectionFrame>
  );
}

interface SubSectionCommonProps {
  onRunCommand?: (line: string) => void;
  serverLog: ReadonlyArray<ServerLogEntry>;
  search: string;
}

// ---- Reusable command-form primitives ------------------------------------

// Predicate used by every command row to decide whether to render in the
// current search-filtered view. Returns true when the row's label or hint
// matches the query (case-insensitive substring). Always-true when the
// query is empty.
function matchesSearch(query: string, label: string, hint?: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (label.toLowerCase().includes(q)) return true;
  if (hint && hint.toLowerCase().includes(q)) return true;
  return false;
}

// Output capture — when a command fires we snapshot the server-log length
// and, after a short window, render any new entries that landed. Most IRC
// commands reply with NOTICEs / numerics from either a service or the
// server itself; both flow through `serverLog`. The wait length is a
// compromise: short enough that the UI feels responsive, long enough that
// multi-line replies (MOTD, HELP) finish arriving.
const OUTPUT_CAPTURE_MS = 3500;
// Cap displayed output so a multi-page MOTD doesn't blow up the layout.
const OUTPUT_CAPTURE_MAX_LINES = 40;

// Numeric reply kinds we explicitly filter OUT of the inline output
// capture, because they're never meaningful as the reply to whatever
// the user just clicked:
//   001-005 are registration/handshake (welcome, yourhost, created,
//   myinfo, isupport). Daemons sometimes re-emit 005 in response to
//   unrelated commands, which would otherwise flood the capture
//   panel with "are supported by this server" lines.
const CAPTURE_NOISE_KINDS = new Set(['001', '002', '003', '004', '005']);

// Filter the captured serverLog entries to the ones that look like
// command replies. Accepts NOTICEs from services/server, PRIVMSGs from
// services, and 3-digit numeric replies (RPL_* / ERR_*). Drops 001-005
// handshake noise + our own outbound PRIVMSGs + CAP frames.
function isReplyEntry(e: ServerLogEntry): boolean {
  if (e.kind === 'NOTICE') return true;
  if (e.kind === 'PRIVMSG' && isServiceLikeSender(e.from)) return true;
  if (/^\d{3}$/.test(e.kind)) {
    if (CAPTURE_NOISE_KINDS.has(e.kind)) return false;
    return true;
  }
  return false;
}

function isServiceLikeSender(from: string): boolean {
  if (!from) return true;
  const lower = from.toLowerCase();
  // Same shape as `isServiceSender` in modules/chat/services.ts.
  return lower.endsWith('serv') || lower === 'global' || from.includes('.');
}

// Render one captured entry as a single line. For numeric replies the
// structured data is split across Args + Message — we stitch them back
// together skipping Args[0] (which is always our own nick on numerics
// and adds no info). For NOTICE / PRIVMSG, Message alone is plenty.
function formatReplyLine(e: ServerLogEntry): string {
  const prefix = e.from ? `<${e.from}> ` : '';
  if (/^\d{3}$/.test(e.kind) && e.args && e.args.length > 0) {
    // Engine populates args = params[1:] for numerics (params[0] is
    // our nick), and Message = the trailing param. So args here is
    // [field1, field2, ..., trailingParam]. We drop the trailing dup
    // since Message already has it, and prepend the remaining fields.
    const fields = e.args.slice(0, -1).join(' ');
    const body = fields ? `${fields} :${e.message}` : e.message;
    return prefix + (body || `[${e.kind}]`);
  }
  return prefix + (e.message || `[${e.kind}]`);
}

// Hook owning capture state for one command row. Returns a `run(cmd)`
// wrapper around `onRunCommand`, plus the current display-ready output
// + capture flag.
function useOutputCapture(
  serverLog: ReadonlyArray<ServerLogEntry>,
  onRunCommand?: (line: string) => void,
): { run: (cmd: string) => void; capturing: boolean; output: string[] | null } {
  const [capturing, setCapturing] = useState(false);
  const [output, setOutput] = useState<string[] | null>(null);
  // Read serverLog through a ref so the timeout callback sees the latest
  // value — the closure captured at run-time would otherwise see only
  // the snapshot from the render that fired the click.
  const logRef = useRef(serverLog);
  logRef.current = serverLog;

  const run = (cmd: string): void => {
    if (!onRunCommand) return;
    const startIdx = logRef.current.length;
    setCapturing(true);
    setOutput(null);
    onRunCommand(cmd);
    setTimeout(() => {
      const fresh = logRef.current.slice(startIdx).filter(isReplyEntry);
      const lines = fresh.map(formatReplyLine).slice(0, OUTPUT_CAPTURE_MAX_LINES);
      setOutput(lines.length === 0 ? ['(no reply captured)'] : lines);
      setCapturing(false);
    }, OUTPUT_CAPTURE_MS);
  };

  return { run, capturing, output };
}

// Renders the captured output beneath a command row. Empty captures
// surface "(no reply captured)" so the user gets feedback even when the
// command was a no-op or the server gagged the reply.
function OutputPanel({ output, capturing }: { output: string[] | null; capturing: boolean }) {
  if (capturing) {
    return <div class="server-settings-cmd-output server-settings-cmd-output-running">Listening for reply…</div>;
  }
  if (!output) return null;
  return (
    <pre class="server-settings-cmd-output">{output.join('\n')}</pre>
  );
}

// Same as NullaryCommand but captures the server's reply for 3.5s and
// renders it underneath. The wrapper-style separation keeps the basic
// fire-and-forget variant available for commands where output capture
// is irrelevant (e.g. NickServ SET PASSWORD).
interface CapturingNullaryProps {
  label: string;
  hint?: string;
  buttonLabel?: string;
  command: string;
  onRunCommand?: (line: string) => void;
  serverLog: ReadonlyArray<ServerLogEntry>;
  search: string;
}
function CapturingNullaryCommand({
  label, hint, buttonLabel = 'Run', command, onRunCommand, serverLog, search,
}: CapturingNullaryProps) {
  if (!matchesSearch(search, label, hint)) return null;
  const { run, capturing, output } = useOutputCapture(serverLog, onRunCommand);
  return (
    <div>
      <div class="server-settings-cmd-row">
        <div class="server-settings-cmd-meta">
          <div class="server-settings-cmd-label">{label}</div>
          {hint && <div class="server-settings-cmd-hint">{hint}</div>}
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => run(command)}
          disabled={!onRunCommand || capturing}
        >
          {capturing ? 'Running…' : buttonLabel}
        </Button>
      </div>
      <OutputPanel output={output} capturing={capturing} />
    </div>
  );
}

// Single-input capturing command: nick, channel, email, etc. Clears the
// input after a successful run so back-to-back queries don't accumulate,
// and renders an output panel below with the server's reply.
interface CapturingOneArgProps {
  label: string;
  hint?: string;
  placeholder: string;
  buttonLabel?: string;
  inputType?: 'text' | 'password';
  buildCommand: (arg: string) => string;
  onRunCommand?: (line: string) => void;
  serverLog: ReadonlyArray<ServerLogEntry>;
  search: string;
}
function CapturingOneArgCommand({
  label, hint, placeholder, buttonLabel = 'Run', inputType = 'text', buildCommand,
  onRunCommand, serverLog, search,
}: CapturingOneArgProps) {
  if (!matchesSearch(search, label, hint)) return null;
  const { run, capturing, output } = useOutputCapture(serverLog, onRunCommand);
  const [value, setValue] = useState('');
  const submit = (e: Event): void => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    run(buildCommand(v));
    setValue('');
  };
  return (
    <div>
      <form onSubmit={submit} class="server-settings-cmd-row">
        <div class="server-settings-cmd-meta">
          <div class="server-settings-cmd-label">{label}</div>
          {hint && <div class="server-settings-cmd-hint">{hint}</div>}
        </div>
        <div class="server-settings-cmd-controls">
          <Input
            type={inputType}
            value={value}
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
            placeholder={placeholder}
            autoComplete="off"
            spellcheck={false}
          />
          <Button type="submit" variant="secondary" size="sm" disabled={!onRunCommand || !value.trim() || capturing}>
            {capturing ? 'Running…' : buttonLabel}
          </Button>
        </div>
      </form>
      <OutputPanel output={output} capturing={capturing} />
    </div>
  );
}

// Two-input capturing command — see CapturingTwoArgCommand below.
interface CapturingTwoArgProps {
  label: string;
  hint?: string;
  placeholders: [string, string];
  inputTypes?: ['text' | 'password', 'text' | 'password'];
  buttonLabel?: string;
  requireSecond?: boolean;
  buildCommand: (a: string, b: string) => string;
  onRunCommand?: (line: string) => void;
  serverLog: ReadonlyArray<ServerLogEntry>;
  search: string;
}
function CapturingTwoArgCommand({
  label, hint, placeholders, inputTypes = ['text', 'text'], buttonLabel = 'Run',
  requireSecond = true, buildCommand, onRunCommand, serverLog, search,
}: CapturingTwoArgProps) {
  if (!matchesSearch(search, label, hint)) return null;
  const { run, capturing, output } = useOutputCapture(serverLog, onRunCommand);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const submit = (e: Event): void => {
    e.preventDefault();
    const aT = a.trim();
    const bT = b.trim();
    if (!aT) return;
    if (requireSecond && !bT) return;
    run(buildCommand(aT, bT));
    setA('');
    setB('');
  };
  return (
    <div>
      <form onSubmit={submit} class="server-settings-cmd-row">
        <div class="server-settings-cmd-meta">
          <div class="server-settings-cmd-label">{label}</div>
          {hint && <div class="server-settings-cmd-hint">{hint}</div>}
        </div>
        <div class="server-settings-cmd-controls server-settings-cmd-controls-two">
          <Input
            type={inputTypes[0]}
            value={a}
            onInput={(e) => setA((e.target as HTMLInputElement).value)}
            placeholder={placeholders[0]}
            autoComplete="off"
            spellcheck={false}
          />
          <Input
            type={inputTypes[1]}
            value={b}
            onInput={(e) => setB((e.target as HTMLInputElement).value)}
            placeholder={placeholders[1]}
            autoComplete="off"
            spellcheck={false}
          />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={!onRunCommand || capturing || !a.trim() || (requireSecond && !b.trim())}
          >
            {capturing ? 'Running…' : buttonLabel}
          </Button>
        </div>
      </form>
      <OutputPanel output={output} capturing={capturing} />
    </div>
  );
}

// Wrapper to hide an entire Card when every command inside it has been
// filtered out by search. Without this, the user gets a string of empty
// cards under the search box for queries that don't match.
function MaybeCard({ visible, children }: { visible: boolean; children: ComponentChildren }) {
  if (!visible) return null;
  return <Card>{children}</Card>;
}

// Helper: does any string in the candidate list match the search query?
// Used by subsection wrappers to decide whether to render their Card.
function anyMatch(search: string, candidates: Array<[string, string?]>): boolean {
  if (!search) return true;
  for (const [label, hint] of candidates) {
    if (matchesSearch(search, label, hint)) return true;
  }
  return false;
}

// ---- Subsection: Services credentials -----------------------------------

interface ServicesSubSectionProps {
  serverId?: string;
  framework: 'atheme' | 'anope' | 'ergo' | 'unknown' | null;
  onTriggerAutoIdentify?: () => void;
}

// Manages the saved NickServ password for this server (used for auto-
// identify on connect). Storage is localStorage (plain text). The
// detected services package badge lives here too since both are
// "services status" concerns.
function ServicesCredentialsSubSection({
  serverId, framework, onTriggerAutoIdentify,
}: ServicesSubSectionProps) {
  const [password, setPassword] = useState<string>('');
  const [hasSaved, setHasSaved] = useState<boolean>(false);
  const [saved, triggerSaved] = useTransientFlag();

  useEffect(() => {
    if (!serverId) {
      setPassword('');
      setHasSaved(false);
      return;
    }
    const store = getServiceCredentialsStore();
    const creds = store.get(serverId);
    setPassword(creds?.nickservPassword ?? '');
    setHasSaved(!!creds?.nickservPassword);
  }, [serverId]);

  const onSave = (e: Event): void => {
    e.preventDefault();
    if (!serverId) return;
    const store = getServiceCredentialsStore();
    if (password.trim()) {
      store.set(serverId, { nickservPassword: password.trim() });
      setHasSaved(true);
      triggerSaved();
    } else {
      store.clear(serverId);
      setHasSaved(false);
      triggerSaved();
    }
  };

  const onClear = (): void => {
    if (!serverId) return;
    getServiceCredentialsStore().clear(serverId);
    setPassword('');
    setHasSaved(false);
  };

  return (
    <Card>
      <div class="server-settings-card-body">
        <h3 class="server-settings-subhead">Services</h3>
        <DetailRow label="Detected" customValue={
          <span class="server-settings-services-fw">
            <Badge tone={framework === 'atheme' || framework === 'anope' || framework === 'ergo' ? 'info' : 'warn'}>
              {frameworkLabel(framework)}
            </Badge>
          </span>
        } />
        <Divider />
        {!serverId ? (
          <p class="server-settings-empty">
            Saved credentials need a stable server id. Reconnect from the directory to enable this section.
          </p>
        ) : (
          <form onSubmit={onSave} class="user-settings-form">
            <Field
              label="NickServ password"
              hint="Stored locally in plain text. Auto-sent as IDENTIFY after the server welcomes us. Leave blank to clear."
            >
              <Input
                type="password"
                value={password}
                onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
                autoComplete="off"
                spellcheck={false}
              />
            </Field>
            <div class="user-settings-form-actions">
              {saved && <span class="user-settings-saved">Saved</span>}
              <Button type="submit" variant="primary">Save</Button>
              {hasSaved && (
                <Button type="button" variant="ghost" onClick={onClear}>Clear</Button>
              )}
              {hasSaved && onTriggerAutoIdentify && (
                <Button type="button" variant="secondary" onClick={onTriggerAutoIdentify}>
                  Identify now
                </Button>
              )}
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

// ---- Subsection: NickServ ------------------------------------------------

// NickServ commands work on both Atheme and Anope with the same surface
// for the basics we expose here (IDENTIFY, GHOST, INFO, REGISTER, GROUP).
// Package-specific divergence (atheme's SET FOO vs anope's SET ENFORCE,
// etc.) is left to the raw slash-command input.
// Helper: command-label list for each subsection so the parent Card can
// MaybeCard-gate on whether any row would render under the current search
// filter. Keeps the labels in one place (top of each subsection).
const NICKSERV_COMMAND_INDEX: Array<[string, string]> = [
  ['IDENTIFY', 'Authenticate the current nick. Most networks auto-fill this if you saved a password above.'],
  ['GHOST', 'Disconnect a stale session holding your nick — e.g. after a reconnect that left a zombie.'],
  ['INFO', 'Look up account info for a nick — registration date, last seen, vhost, etc.'],
  ['REGISTER', 'Claim the current nick as an account. Server may email a confirmation.'],
  ['GROUP', 'Link this nick to your already-identified account (Atheme). Anope users may need ALIAS — try GROUP first.'],
  ['SET PASSWORD', 'Change your account password. Requires being identified first.'],
  ['SET EMAIL', 'Change the email on file. Server may require re-confirmation.'],
];

function NickServSubSection({
  myNick, onRunCommand, serverLog, search,
}: { myNick: string } & SubSectionCommonProps) {
  const cmd = (verb: string): string => `/msg NickServ ${verb}`;
  return (
    <MaybeCard visible={anyMatch(search, NICKSERV_COMMAND_INDEX)}>
      <div class="server-settings-card-body">
        <h3 class="server-settings-subhead">NickServ</h3>
        <p class="server-settings-subhint">
          Manages your registered nickname / account. You are <code>{myNick}</code>.
        </p>
        <Divider />
        <CapturingOneArgCommand
          label="IDENTIFY"
          hint={NICKSERV_COMMAND_INDEX[0]![1]}
          placeholder="password"
          inputType="password"
          buttonLabel="Identify"
          buildCommand={(pw) => cmd(`IDENTIFY ${pw}`)}
          onRunCommand={onRunCommand}
          serverLog={serverLog}
          search={search}
        />
        <CapturingTwoArgCommand
          label="GHOST"
          hint={NICKSERV_COMMAND_INDEX[1]![1]}
          placeholders={['nick', 'password']}
          inputTypes={['text', 'password']}
          buttonLabel="Ghost"
          requireSecond={false}
          buildCommand={(nick, pw) => cmd(pw ? `GHOST ${nick} ${pw}` : `GHOST ${nick}`)}
          onRunCommand={onRunCommand}
          serverLog={serverLog}
          search={search}
        />
        <CapturingOneArgCommand
          label="INFO"
          hint={NICKSERV_COMMAND_INDEX[2]![1]}
          placeholder="nick"
          buttonLabel="Info"
          buildCommand={(nick) => cmd(`INFO ${nick}`)}
          onRunCommand={onRunCommand}
          serverLog={serverLog}
          search={search}
        />
        <CapturingTwoArgCommand
          label="REGISTER"
          hint={NICKSERV_COMMAND_INDEX[3]![1]}
          placeholders={['password', 'email']}
          inputTypes={['password', 'text']}
          buttonLabel="Register"
          buildCommand={(pw, email) => cmd(`REGISTER ${pw} ${email}`)}
          onRunCommand={onRunCommand}
          serverLog={serverLog}
          search={search}
        />
        <CapturingNullaryCommand
          label="GROUP"
          hint={NICKSERV_COMMAND_INDEX[4]![1]}
          buttonLabel="Group"
          command={cmd('GROUP')}
          onRunCommand={onRunCommand}
          serverLog={serverLog}
          search={search}
        />
        <CapturingOneArgCommand
          label="SET PASSWORD"
          hint={NICKSERV_COMMAND_INDEX[5]![1]}
          placeholder="new password"
          inputType="password"
          buttonLabel="Change"
          buildCommand={(pw) => cmd(`SET PASSWORD ${pw}`)}
          onRunCommand={onRunCommand}
          serverLog={serverLog}
          search={search}
        />
        <CapturingOneArgCommand
          label="SET EMAIL"
          hint={NICKSERV_COMMAND_INDEX[6]![1]}
          placeholder="new email"
          buttonLabel="Change"
          buildCommand={(email) => cmd(`SET EMAIL ${email}`)}
          onRunCommand={onRunCommand}
          serverLog={serverLog}
          search={search}
        />
      </div>
    </MaybeCard>
  );
}

// ---- Subsection: Lookups (WHOIS / WHOWAS / WHO) -------------------------

const LOOKUP_COMMAND_INDEX: Array<[string, string]> = [
  ['WHOIS', 'Look up info about another nick — account, channels, idle, server.'],
  ['WHOWAS', "Look up a nick that has recently quit — same fields as WHOIS, drawn from server's history cache."],
  ['WHO', 'List users matching a mask or in a channel. e.g. `#general` or `*!*@evil.example.com`.'],
];

function LookupCommandsSubSection({
  myNick, onRunCommand, serverLog, search,
}: { myNick: string } & SubSectionCommonProps) {
  return (
    <MaybeCard visible={anyMatch(search, LOOKUP_COMMAND_INDEX)}>
      <div class="server-settings-card-body">
        <h3 class="server-settings-subhead">Lookups</h3>
        <p class="server-settings-subhint">
          Find out about another user. You are <code>{myNick}</code>.
        </p>
        <Divider />
        <CapturingOneArgCommand
          label="WHOIS"
          hint={LOOKUP_COMMAND_INDEX[0]![1]}
          placeholder="nick"
          buttonLabel="WHOIS"
          buildCommand={(nick) => `/whois ${nick}`}
          onRunCommand={onRunCommand}
          serverLog={serverLog}
          search={search}
        />
        <CapturingOneArgCommand
          label="WHOWAS"
          hint={LOOKUP_COMMAND_INDEX[1]![1]}
          placeholder="nick"
          buttonLabel="WHOWAS"
          buildCommand={(nick) => `/whowas ${nick}`}
          onRunCommand={onRunCommand}
          serverLog={serverLog}
          search={search}
        />
        <CapturingOneArgCommand
          label="WHO"
          hint={LOOKUP_COMMAND_INDEX[2]![1]}
          placeholder="#channel or mask"
          buttonLabel="WHO"
          buildCommand={(arg) => `/who ${arg}`}
          onRunCommand={onRunCommand}
          serverLog={serverLog}
          search={search}
        />
      </div>
    </MaybeCard>
  );
}

// ---- Subsection: ChanServ ------------------------------------------------

const CHANSERV_COMMAND_INDEX: Array<[string, string]> = [
  ['REGISTER', 'Register a channel you currently hold ops in. Becomes the founder.'],
  ['INFO', 'Show registration / founder / settings for a channel.'],
  ['OP (self)', 'Op yourself in a channel where you have access.'],
  ['OP user', 'Op another nick in a channel where you have access.'],
  ['VOICE', 'Grant +v voice to a user in a channel.'],
  ['KICK', 'Remove a user from a channel through ChanServ (uses your access).'],
  ['BAN', 'Set a ban (+b) on a nick / mask in a channel.'],
  ['RECOVER', "Reclaim a channel where you've lost ops (kick splits, deop wars). Restores you as founder."],
  ['TRANSFER', 'Hand founder rights to another account. Irreversible — both packages require a confirmation step.'],
];

function ChanServSubSection({ onRunCommand, serverLog, search }: SubSectionCommonProps) {
  const cmd = (verb: string): string => `/msg ChanServ ${verb}`;
  return (
    <MaybeCard visible={anyMatch(search, CHANSERV_COMMAND_INDEX)}>
      <div class="server-settings-card-body">
        <h3 class="server-settings-subhead">ChanServ</h3>
        <p class="server-settings-subhint">
          Channel registration + operator tools. Channel names must include their <code>#</code> prefix.
        </p>
        <Divider />
        <CapturingOneArgCommand
          label="REGISTER" hint={CHANSERV_COMMAND_INDEX[0]![1]}
          placeholder="#channel" buttonLabel="Register"
          buildCommand={(chan) => cmd(`REGISTER ${chan}`)}
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        <CapturingOneArgCommand
          label="INFO" hint={CHANSERV_COMMAND_INDEX[1]![1]}
          placeholder="#channel" buttonLabel="Info"
          buildCommand={(chan) => cmd(`INFO ${chan}`)}
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        <CapturingOneArgCommand
          label="OP (self)" hint={CHANSERV_COMMAND_INDEX[2]![1]}
          placeholder="#channel" buttonLabel="Op"
          buildCommand={(chan) => cmd(`OP ${chan}`)}
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        <CapturingTwoArgCommand
          label="OP user" hint={CHANSERV_COMMAND_INDEX[3]![1]}
          placeholders={['#channel', 'nick']} buttonLabel="Op"
          buildCommand={(chan, nick) => cmd(`OP ${chan} ${nick}`)}
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        <CapturingTwoArgCommand
          label="VOICE" hint={CHANSERV_COMMAND_INDEX[4]![1]}
          placeholders={['#channel', 'nick']} buttonLabel="Voice"
          buildCommand={(chan, nick) => cmd(`VOICE ${chan} ${nick}`)}
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        <CapturingTwoArgCommand
          label="KICK" hint={CHANSERV_COMMAND_INDEX[5]![1]}
          placeholders={['#channel', 'nick']} buttonLabel="Kick"
          buildCommand={(chan, nick) => cmd(`KICK ${chan} ${nick}`)}
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        <CapturingTwoArgCommand
          label="BAN" hint={CHANSERV_COMMAND_INDEX[6]![1]}
          placeholders={['#channel', 'nick or mask']} buttonLabel="Ban"
          buildCommand={(chan, target) => cmd(`BAN ${chan} ${target}`)}
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        <CapturingOneArgCommand
          label="RECOVER" hint={CHANSERV_COMMAND_INDEX[7]![1]}
          placeholder="#channel" buttonLabel="Recover"
          buildCommand={(chan) => cmd(`RECOVER ${chan}`)}
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        <CapturingTwoArgCommand
          label="TRANSFER" hint={CHANSERV_COMMAND_INDEX[8]![1]}
          placeholders={['#channel', 'new owner nick']} buttonLabel="Transfer"
          buildCommand={(chan, who) => cmd(`TRANSFER ${chan} ${who}`)}
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
      </div>
    </MaybeCard>
  );
}

// ---- Subsection: MemoServ ------------------------------------------------

const MEMOSERV_COMMAND_INDEX: Array<[string, string]> = [
  ['LIST', 'Show your incoming memos (read + unread, newest first).'],
  ['READ', 'Read a specific memo by number (use LIST first to see ids).'],
  ['SEND', 'Send a memo to another nick. The recipient must have a registered account.'],
  ['DEL', 'Delete a memo by number. Pass ALL to clear the whole inbox.'],
];

function MemoServSubSection({ onRunCommand, serverLog, search }: SubSectionCommonProps) {
  const cmd = (verb: string): string => `/msg MemoServ ${verb}`;
  return (
    <MaybeCard visible={anyMatch(search, MEMOSERV_COMMAND_INDEX)}>
      <div class="server-settings-card-body">
        <h3 class="server-settings-subhead">MemoServ</h3>
        <p class="server-settings-subhint">
          Offline messages between registered accounts. Stays on the server until read.
        </p>
        <Divider />
        <CapturingNullaryCommand
          label="LIST" hint={MEMOSERV_COMMAND_INDEX[0]![1]}
          buttonLabel="List" command={cmd('LIST')}
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        <CapturingOneArgCommand
          label="READ" hint={MEMOSERV_COMMAND_INDEX[1]![1]}
          placeholder="memo number" buttonLabel="Read"
          buildCommand={(n) => cmd(`READ ${n}`)}
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        <CapturingTwoArgCommand
          label="SEND" hint={MEMOSERV_COMMAND_INDEX[2]![1]}
          placeholders={['nick', 'message']} buttonLabel="Send"
          buildCommand={(to, msg) => cmd(`SEND ${to} ${msg}`)}
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        <CapturingOneArgCommand
          label="DEL" hint={MEMOSERV_COMMAND_INDEX[3]![1]}
          placeholder="memo number or ALL" buttonLabel="Delete"
          buildCommand={(n) => cmd(`DEL ${n}`)}
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
      </div>
    </MaybeCard>
  );
}

// ---- Subsection: HostServ ------------------------------------------------

const HOSTSERV_COMMAND_INDEX: Array<[string, string]> = [
  ['REQUEST', 'Ask staff to grant a custom vhost (e.g., my.cool.cloak). Approval is manual.'],
  ['ON', 'Activate your assigned vhost on this session.'],
  ['OFF', 'Drop the vhost for the current session (revert to default ident@host).'],
];

function HostServSubSection({ onRunCommand, serverLog, search }: SubSectionCommonProps) {
  const cmd = (verb: string): string => `/msg HostServ ${verb}`;
  return (
    <MaybeCard visible={anyMatch(search, HOSTSERV_COMMAND_INDEX)}>
      <div class="server-settings-card-body">
        <h3 class="server-settings-subhead">HostServ</h3>
        <p class="server-settings-subhint">
          Virtual hostname (cloak) management. Many networks don't run HostServ — commands will silently fail there.
        </p>
        <Divider />
        <CapturingOneArgCommand
          label="REQUEST" hint={HOSTSERV_COMMAND_INDEX[0]![1]}
          placeholder="my.cloak.example" buttonLabel="Request"
          buildCommand={(vhost) => cmd(`REQUEST ${vhost}`)}
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        <CapturingNullaryCommand
          label="ON" hint={HOSTSERV_COMMAND_INDEX[1]![1]}
          buttonLabel="On" command={cmd('ON')}
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        <CapturingNullaryCommand
          label="OFF" hint={HOSTSERV_COMMAND_INDEX[2]![1]}
          buttonLabel="Off" command={cmd('OFF')}
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
      </div>
    </MaybeCard>
  );
}

// ---- Subsection: User modes ---------------------------------------------

interface UserModeToggleProps {
  mode: string;        // single-letter mode flag, e.g. 'i'
  label: string;
  hint: string;
  myNick: string;
  onRunCommand?: (line: string) => void;
  serverLog: ReadonlyArray<ServerLogEntry>;
  search: string;
}

// User modes are set with `/mode <mynick> +x` / `-x`. Both buttons share
// a single output panel so the user can see the MODE reply that came
// back from the server (which is often the only visible feedback that
// the mode change took effect).
function UserModeToggle({ mode, label, hint, myNick, onRunCommand, serverLog, search }: UserModeToggleProps) {
  // Search matches against the label, hint, OR the raw mode letter so
  // a query like "+i" matches the Invisible row.
  if (!matchesSearch(search, `${label} +${mode}`, hint)) return null;
  const { run, capturing, output } = useOutputCapture(serverLog, onRunCommand);
  return (
    <div>
      <div class="server-settings-cmd-row">
        <div class="server-settings-cmd-meta">
          <div class="server-settings-cmd-label">{label} <code>+{mode}</code></div>
          <div class="server-settings-cmd-hint">{hint}</div>
        </div>
        <div class="server-settings-cmd-controls">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => run(`/mode ${myNick} +${mode}`)}
            disabled={!onRunCommand || capturing}
          >
            {capturing ? '…' : 'Enable'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => run(`/mode ${myNick} -${mode}`)}
            disabled={!onRunCommand || capturing}
          >
            Disable
          </Button>
        </div>
      </div>
      <OutputPanel output={output} capturing={capturing} />
    </div>
  );
}

const USER_MODE_INDEX: Array<[string, string]> = [
  ['Invisible +i', 'Hide from /who and /names for users not in your channels.'],
  ['Wallops +w', 'Receive network-wide WALLOPS broadcasts from opers.'],
  ['Registered-only DMs +R', 'Reject PRIVMSGs from users without a NickServ account. Common spam guard.'],
  ['Deaf to channels +D', 'Stop receiving channel messages but stay joined (useful for log-only bots).'],
  ['Caller ID +g', 'Solanum/InspIRCd: silently drop messages from anyone not on your accept-list.'],
];

function UserModesSubSection({
  myNick, onRunCommand, serverLog, search,
}: { myNick: string } & SubSectionCommonProps) {
  return (
    <MaybeCard visible={anyMatch(search, USER_MODE_INDEX)}>
      <div class="server-settings-card-body">
        <h3 class="server-settings-subhead">User modes</h3>
        <p class="server-settings-subhint">
          Per-user flags. Not all networks support every flag — Enable/Disable issue <code>MODE {myNick} +x</code> / <code>-x</code> and the server's reply shows below each row.
        </p>
        <Divider />
        <UserModeToggle mode="i" label="Invisible" hint={USER_MODE_INDEX[0]![1]}
          myNick={myNick} onRunCommand={onRunCommand} serverLog={serverLog} search={search} />
        <UserModeToggle mode="w" label="Wallops" hint={USER_MODE_INDEX[1]![1]}
          myNick={myNick} onRunCommand={onRunCommand} serverLog={serverLog} search={search} />
        <UserModeToggle mode="R" label="Registered-only DMs" hint={USER_MODE_INDEX[2]![1]}
          myNick={myNick} onRunCommand={onRunCommand} serverLog={serverLog} search={search} />
        <UserModeToggle mode="D" label="Deaf to channels" hint={USER_MODE_INDEX[3]![1]}
          myNick={myNick} onRunCommand={onRunCommand} serverLog={serverLog} search={search} />
        <UserModeToggle mode="g" label="Caller ID" hint={USER_MODE_INDEX[4]![1]}
          myNick={myNick} onRunCommand={onRunCommand} serverLog={serverLog} search={search} />
      </div>
    </MaybeCard>
  );
}

// ---- Subsection: IRC commands -------------------------------------------

const ACCOUNT_COMMAND_INDEX: Array<[string, string]> = [
  ['NICK', 'Change your nickname on this server. The server may sanitize or reject.'],
  ['AWAY', "Mark yourself away with a reason. Use Back to clear it."],
  ['BACK', "Clear your away state."],
];

function AccountSubSection({
  myNick, onRunCommand, serverLog, search,
}: { myNick: string } & SubSectionCommonProps) {
  // AWAY needs its own state because the "Back" button next to it is a
  // peer of the submit button — clicking it should clear the input AND
  // capture the resulting RPL_UNAWAY (305). Sharing the capture hook
  // across both buttons keeps the output panel logic single-sourced.
  const { run, capturing, output } = useOutputCapture(serverLog, onRunCommand);
  const [awayMessage, setAwayMessage] = useState('');
  const submitAway = (e: Event): void => {
    e.preventDefault();
    const msg = awayMessage.trim();
    if (!msg) return;
    run(`/away ${msg}`);
    setAwayMessage('');
  };
  const awayMatches = matchesSearch(search, 'AWAY', ACCOUNT_COMMAND_INDEX[1]![1])
    || matchesSearch(search, 'BACK', ACCOUNT_COMMAND_INDEX[2]![1]);
  return (
    <MaybeCard visible={anyMatch(search, ACCOUNT_COMMAND_INDEX)}>
      <div class="server-settings-card-body">
        <h3 class="server-settings-subhead">Account</h3>
        <p class="server-settings-subhint">
          Identity actions for this connection. You are <code>{myNick}</code>.
        </p>
        <Divider />
        <CapturingOneArgCommand
          label="NICK" hint={ACCOUNT_COMMAND_INDEX[0]![1]}
          placeholder="new nick" buttonLabel="Change"
          buildCommand={(nick) => `/nick ${nick}`}
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        {awayMatches && (
          <div>
            <form onSubmit={submitAway} class="server-settings-cmd-row">
              <div class="server-settings-cmd-meta">
                <div class="server-settings-cmd-label">AWAY / BACK</div>
                <div class="server-settings-cmd-hint">{ACCOUNT_COMMAND_INDEX[1]![1]}</div>
              </div>
              <div class="server-settings-cmd-controls">
                <Input
                  value={awayMessage}
                  onInput={(e) => setAwayMessage((e.target as HTMLInputElement).value)}
                  placeholder="back in 5"
                  autoComplete="off"
                  spellcheck={false}
                />
                <Button type="submit" variant="secondary" size="sm"
                  disabled={!onRunCommand || !awayMessage.trim() || capturing}>
                  {capturing ? '…' : 'Away'}
                </Button>
                <Button type="button" variant="ghost" size="sm"
                  disabled={!onRunCommand || capturing}
                  onClick={() => { setAwayMessage(''); run('/back'); }}>
                  Back
                </Button>
              </div>
            </form>
            <OutputPanel output={output} capturing={capturing} />
          </div>
        )}
      </div>
    </MaybeCard>
  );
}

const SERVER_INFO_INDEX: Array<[string, string]> = [
  ['LIST', "Refresh the server's public channel directory (RPL_LIST). Replies may be large; the engine caches the result."],
  ['LIST (no filter)', 'Same as above but with no filter — every public channel.'],
  ['MOTD', "Re-fetch the server's Message of the Day."],
  ['LUSERS', 'Server-wide user / channel / oper counts.'],
  ['VERSION', 'Server software banner.'],
  ['ADMIN', 'Network admin contact info.'],
  ['TIME', "Server's local time."],
  ['LINKS', 'Map of servers linked into this network (often gagged for privacy).'],
];

function ServerInfoSubSection({ onRunCommand, serverLog, search }: SubSectionCommonProps) {
  return (
    <MaybeCard visible={anyMatch(search, SERVER_INFO_INDEX)}>
      <div class="server-settings-card-body">
        <h3 class="server-settings-subhead">Server info</h3>
        <p class="server-settings-subhint">
          Read-only server queries. Replies (numeric or NOTICE) capture inline.
        </p>
        <Divider />
        <CapturingOneArgCommand
          label="LIST" hint={SERVER_INFO_INDEX[0]![1]}
          placeholder="optional filter, e.g. >5 or *foo*" buttonLabel="List"
          buildCommand={(arg) => `/list ${arg}`}
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        <CapturingNullaryCommand
          label="LIST (no filter)" hint={SERVER_INFO_INDEX[1]![1]}
          buttonLabel="List all" command="/list"
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        <CapturingNullaryCommand
          label="MOTD" hint={SERVER_INFO_INDEX[2]![1]}
          buttonLabel="MOTD" command="/motd"
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        <CapturingNullaryCommand
          label="LUSERS" hint={SERVER_INFO_INDEX[3]![1]}
          buttonLabel="LUSERS" command="/lusers"
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        <CapturingNullaryCommand
          label="VERSION" hint={SERVER_INFO_INDEX[4]![1]}
          buttonLabel="VERSION" command="/version"
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        <CapturingNullaryCommand
          label="ADMIN" hint={SERVER_INFO_INDEX[5]![1]}
          buttonLabel="ADMIN" command="/admin"
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        <CapturingNullaryCommand
          label="TIME" hint={SERVER_INFO_INDEX[6]![1]}
          buttonLabel="TIME" command="/time"
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
        <CapturingNullaryCommand
          label="LINKS" hint={SERVER_INFO_INDEX[7]![1]}
          buttonLabel="LINKS" command="/links"
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
      </div>
    </MaybeCard>
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
