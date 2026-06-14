import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Badge, Button, Card, ChipInput, Divider, Field, Input, Tabs, Toggle, useTransientFlag } from '@boson/shared';
import type { ServerInfo, ServerLogEntry } from '../../modules/chat';
import {
  getServiceCredentialsStore,
  type AccountStatus,
  type ServiceCredentials,
} from '../../modules/chat/services-credentials';
import { getAdapter } from '../../modules/chat/adapters';
import type { ServicesAdapter } from '../../modules/chat/adapters';
import { Avatar } from '../../shared/Avatar/Avatar';
import { HttpError } from '../../shared/http/http.client';
import type { DropResult, IdentifyResult, RegisterResult, ConfirmResult, ResendResult, UnsupportedResult } from '../../modules/chat/account-service';
import type { ClaimResult, ResumeConfirmResult } from '../../modules/chat/chat.service';
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

type SectionId = 'info' | 'identity' | 'advanced' | 'edit' | 'opers' | 'bouncer' | 'actions' | 'log';

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
  iconUrl?: string;
  bannerUrl?: string;
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
  // Step 2 of the AccountService migration. When present, the
  // Identity section's Drop button calls this instead of building
  // a raw command via the legacy adapter. The promise resolves to
  // a discrete DropResult once the multi-step Anope/Atheme/Ergo
  // dance has fully completed (or timed out).
  onDropAccount?: (accountName: string, password: string) => Promise<DropResult>;
  // Step 5. Manual "Identify now" path that returns a discrete
  // IdentifyResult — the panel surfaces wrong-password / no-such-
  // account inline instead of just waiting for the badge to flip.
  // Falls back to onTriggerAutoIdentify (fire-and-forget) when
  // omitted, preserving compatibility with mid-migration callers.
  onIdentifyAccount?: (password: string) => Promise<IdentifyResult>;
  // Step 6. Register button uses this when present — returns a
  // discrete RegisterResult (pending-confirmation / registered /
  // nick-taken / email-rejected / failed). Falls back to the
  // legacy onRunCommand path when omitted.
  onRegisterAccount?: (password: string, email: string) => Promise<RegisterResult>;
  // Step 7. Confirm button uses this when present — discrete
  // ConfirmResult (confirmed / wrong-code / expired / failed).
  onConfirmAccount?: (accountName: string, code: string) => Promise<ConfirmResult>;
  // Step 8. Resend uses the new AccountService path. Returns
  // ResendResult (sent/cooldown/failed) or UnsupportedResult on
  // packages that don't have a resend (Atheme/Ergo).
  onResendConfirmation?: (accountName: string) => Promise<ResendResult | UnsupportedResult>;
  // True when this network's services package supports resend.
  // When false, the panel hides the Resend button entirely.
  supportsResend?: boolean;
  // Automated "claim this nick" flow for signed-in users. Returns
  // a discrete ClaimResult once the full mint-email → REGISTER →
  // poll-for-code → CONFIRM dance settles (or the caller aborts
  // via the AbortSignal). Threaded through to IdentitySection.
  onClaimNick?: (accountName: string, opts?: { signal?: AbortSignal }) => Promise<ClaimResult>;
  // Silent NickServ state probe. When present, the Identity panel
  // probes the nick on open and shows the CTA that matches the actual
  // server-side state (Claim only when unregistered, Confirm when
  // registered-but-unconfirmed, Identify when registered + confirmed)
  // instead of optimistically offering Register. Resolves to the
  // detected status, or undefined when it couldn't be determined.
  onDetectAccountState?: (accountName?: string) => Promise<AccountStatus | undefined>;
  // Finish a stranded confirmation: when the nick is registered-but-
  // unconfirmed and a backend claim is still pending, this polls for
  // the captured email code and fires CONFIRM automatically. The
  // Identity panel calls it on open for that state.
  onResumeConfirmation?: (accountName?: string, opts?: { signal?: AbortSignal }) => Promise<ResumeConfirmResult>;
  // True when the parent app has a Boson-authenticated session. The
  // Identity panel uses this to decide whether to show the Claim
  // button (signed in only) or the existing manual register form.
  signedIn?: boolean;
  // Optional — when both are present, an "Edit" tab is added that
  // lets the row's owner update profile-shaped fields and submit
  // them through onSaveProfile (which hits PATCH /servers/{id}).
  // Identity fields (hostname/port/tls) stay read-only here — they'd
  // invalidate the existing verification if mutated. The parent is
  // expected to gate this on (authed && server.registered_by === me.id).
  directoryEntry?: DirectoryEntryProfile;
  onSaveProfile?: (patch: Partial<DirectoryEntryProfile>) => Promise<void>;
  // Upload (image != null) or remove (null) the listing's icon/banner.
  onSaveServerImage?: (kind: 'icon' | 'banner', image: Blob | null) => Promise<void>;
  // Whether we're an IRC operator on this connection (numeric 381 / self
  // +o). Drives the Operators tab's "Operator" badge and gates the live
  // OperServ management controls. The Operators tab itself is owner-gated
  // the same way as Edit (presence of directoryEntry + onSaveProfile).
  isOper?: boolean;
  // ---- Bouncer (per-server routing) -----------------------------------
  // Current per-server bouncer route for this connection (from the saved
  // session), or undefined when none is configured.
  bouncerRoute?: { route: boolean; network: string };
  // Whether the user's GLOBAL bouncer profile is enabled — drives the
  // "enable it in User Settings first" banner.
  bouncerGloballyEnabled?: boolean;
  // Persist the per-server route. Takes effect on the next (re)connect.
  onSaveBouncerRoute?: (route: { route: boolean; network: string }) => void;
}

interface MenuItem {
  id: SectionId;
  label: string;
  description: string;
}

const MENU: readonly MenuItem[] = [
  { id: 'info',     label: 'Info',      description: 'Server software + IRCv3 capabilities' },
  { id: 'identity', label: 'Identity',  description: 'Your nick + NickServ login' },
  { id: 'edit',     label: 'Edit',      description: 'Directory profile — owner only' },
  { id: 'opers',    label: 'Operators', description: 'Grant operator access — owner only' },
  { id: 'bouncer',  label: 'Bouncer',   description: 'Route this server through your ZNC' },
  { id: 'actions',  label: 'Actions',   description: 'Reconnect or disconnect' },
  { id: 'log',      label: 'Log',       description: 'Raw engine event log' },
  { id: 'advanced', label: 'Advanced',  description: 'IRC + services command UI' },
];

export function ServerSettings({
  serverDisplayName, myNick, serverInfo, serverLog, onClearServerLog, onClose, onReconnect, onDisconnect, onChangeNick,
  serverId, servicesFramework = null, onTriggerAutoIdentify, onRunCommand, onDropAccount, onIdentifyAccount, onRegisterAccount, onConfirmAccount, onResendConfirmation, supportsResend, onClaimNick, onDetectAccountState, onResumeConfirmation, signedIn,
  directoryEntry, onSaveProfile, onSaveServerImage, isOper = false,
  bouncerRoute, bouncerGloballyEnabled = false, onSaveBouncerRoute,
}: ServerSettingsProps) {
  const [section, setSection] = useState<SectionId>('info');
  // Hide the owner-only tabs (Edit + Operators) when the parent didn't pass
  // ownership context. Filtering at render time keeps the menu uncluttered
  // for the 99% of viewers who don't own the row.
  const editable = !!(directoryEntry && onSaveProfile);
  const visibleMenu = editable ? MENU : MENU.filter((m) => m.id !== 'edit' && m.id !== 'opers');

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
          {section === 'identity' && (
            <IdentitySection
              myNick={myNick}
              onChangeNick={onChangeNick}
              serverId={serverId}
              servicesFramework={servicesFramework}
              onTriggerAutoIdentify={onTriggerAutoIdentify}
              onRunCommand={onRunCommand}
              onDropAccount={onDropAccount}
              onIdentifyAccount={onIdentifyAccount}
              onRegisterAccount={onRegisterAccount}
              onConfirmAccount={onConfirmAccount}
              onResendConfirmation={onResendConfirmation}
              supportsResend={supportsResend}
              onClaimNick={onClaimNick}
              onDetectAccountState={onDetectAccountState}
              onResumeConfirmation={onResumeConfirmation}
              signedIn={signedIn}
            />
          )}
          {section === 'advanced' && (
            <AdvancedSection
              myNick={myNick}
              onRunCommand={onRunCommand}
              serverLog={serverLog}
            />
          )}
          {section === 'edit' && editable && directoryEntry && onSaveProfile && (
            <EditProfileSection entry={directoryEntry} onSave={onSaveProfile} onSaveImage={onSaveServerImage} />
          )}
          {section === 'opers' && editable && (
            <OperatorsSection
              servicesFramework={servicesFramework}
              isOper={isOper}
              onRunCommand={onRunCommand}
              serverLog={serverLog}
            />
          )}
          {section === 'bouncer' && (
            <BouncerServerSection
              route={bouncerRoute}
              globallyEnabled={bouncerGloballyEnabled}
              onSave={onSaveBouncerRoute}
            />
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

interface IdentitySectionProps {
  myNick: string;
  onChangeNick?: (nick: string) => void;
  serverId?: string;
  servicesFramework: 'atheme' | 'anope' | 'ergo' | 'unknown' | null;
  onTriggerAutoIdentify?: () => void;
  onRunCommand?: (line: string) => void;
  // Step 2 of the AccountService migration — when present, the
  // Identity section calls this for the Drop button instead of
  // building a raw command via the legacy adapter. Returns a
  // discrete DropResult so the panel can surface a precise error
  // (wrong password / no such account / timeout) instead of
  // waiting for the credentials store to flip.
  onDropAccount?: (accountName: string, password: string) => Promise<DropResult>;
  // Step 5 — same shape as onDropAccount but for IDENTIFY.
  onIdentifyAccount?: (password: string) => Promise<IdentifyResult>;
  // Step 6 — same shape but for REGISTER.
  onRegisterAccount?: (password: string, email: string) => Promise<RegisterResult>;
  // Step 7 — discrete ConfirmResult.
  onConfirmAccount?: (accountName: string, code: string) => Promise<ConfirmResult>;
  // Step 8 props (same shape as the top-level one — re-declared
  // here because IdentitySectionProps drives the inner section
  // directly rather than spreading the parent props).
  onResendConfirmation?: (accountName: string) => Promise<ResendResult | UnsupportedResult>;
  supportsResend?: boolean;
  // Automated "claim this nick" flow — present only for signed-in
  // users. When set, the Identity panel shows a "Claim Nyan on this
  // network" button on top of the manual register/identify form;
  // clicking it kicks off the backend-mediated email-confirmation
  // dance and returns a discrete ClaimResult.
  onClaimNick?: (accountName: string, opts?: { signal?: AbortSignal }) => Promise<ClaimResult>;
  // Silent NickServ state probe — see ServerSettingsProps.onDetectAccountState.
  onDetectAccountState?: (accountName?: string) => Promise<AccountStatus | undefined>;
  // Auto-resume confirm — see ServerSettingsProps.onResumeConfirmation.
  onResumeConfirmation?: (accountName?: string, opts?: { signal?: AbortSignal }) => Promise<ResumeConfirmResult>;
  signedIn?: boolean;
}

// Identity owns the full per-server account surface: current nick +
// change-nick, plus the NickServ account flow (status, password,
// email, register, confirm). One unified Card so it reads as a
// single screen of "who you are on this network" rather than a stack
// of unrelated panels.
//
// The raw "/msg NickServ <verb>" forms in Advanced → NickServ stay
// for power-user use; everything a normal user wants is here.
function IdentitySection({
  myNick, onChangeNick,
  serverId, servicesFramework, onTriggerAutoIdentify, onRunCommand, onDropAccount, onIdentifyAccount, onRegisterAccount, onConfirmAccount, onResendConfirmation, supportsResend, onClaimNick, onDetectAccountState, onResumeConfirmation, signedIn,
}: IdentitySectionProps) {
  // --- Change-nick state ----------------------------------------------
  // Optimistic input: we update the local draft as the user types, and
  // submit dispatches through onChangeNick. The actual rename only
  // applies when the server echoes a NICK event — which the bloc
  // handles globally — so this form intentionally doesn't update the
  // visible "Nick" row directly. If the server rejects (433 in-use,
  // 432 bad), the chat service surfaces an error banner.
  const [nickDraft, setNickDraft] = useState(myNick);
  useEffect(() => { setNickDraft(myNick); }, [myNick]);
  const submitNick = (e: Event): void => {
    e.preventDefault();
    const next = nickDraft.trim();
    if (!onChangeNick || !next || next === myNick) return;
    onChangeNick(next);
  };

  // --- Account state --------------------------------------------------
  // Form values shadow the saved credentials so the user can edit
  // before committing. The subscribe below keeps everything in sync
  // with ChatService's classifier writes.
  const [accountName, setAccountName] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [confirmCode, setConfirmCode] = useState<string>('');
  const [savedFlash, triggerSavedFlash] = useTransientFlag();
  const [creds, setCreds] = useState<ServiceCredentials | null>(null);
  // Password reveal + copy controls — the auto-claim flow generates a
  // random password the user has never seen. They need to see it once
  // (to copy into a password manager) before it gets masked behind a
  // <input type="password">. `passwordCopied` is a transient flag the
  // copy button toggles for ~2s to confirm clipboard write.
  const [passwordShown, setPasswordShown] = useState<boolean>(false);
  const [passwordCopied, setPasswordCopied] = useState<boolean>(false);
  // Two-state confirm for the destructive Drop action. First click on
  // "Drop account" flips this to true and reveals an inline confirm /
  // cancel pair in place of the original button. Resets to false
  // whenever the active server changes or the saved password is
  // cleared (so a stale "really drop?" never lingers across nicks).
  const [dropConfirming, setDropConfirming] = useState(false);

  useEffect(() => {
    if (!serverId) {
      setCreds(null);
      setAccountName(''); setPassword(''); setEmail('');
      return;
    }
    return getServiceCredentialsStore().subscribe(serverId, (v) => {
      setCreds(v);
      setAccountName(v?.accountName ?? '');
      setPassword(v?.nickservPassword ?? '');
      setEmail(v?.email ?? '');
      // Cancel any in-flight "really drop?" prompt if the underlying
      // creds change out from under us (server flip, classifier wrote
      // a new status, etc.). The user shouldn't accidentally confirm
      // a stale action.
      setDropConfirming(false);
    });
  }, [serverId]);

  const onSaveCreds = (e: Event): void => {
    e.preventDefault();
    if (!serverId) return;
    const store = getServiceCredentialsStore();
    const pw = password.trim(), em = email.trim(), acct = accountName.trim();
    if (!pw && !em && !acct) {
      store.clear(serverId);
      triggerSavedFlash();
      return;
    }
    store.set(serverId, {
      ...(creds ?? {}),
      nickservPassword: pw || undefined,
      email: em || undefined,
      accountName: acct || undefined,
    });
    triggerSavedFlash();
  };

  const onClearCreds = (): void => {
    if (!serverId) return;
    getServiceCredentialsStore().clear(serverId);
  };

  // Inline feedback for REGISTER outcomes (Step 6). Cleared when
  // the user retries.
  const [registerStatus, setRegisterStatus] = useState<{ kind: 'pending' | 'success' | 'error'; message: string } | null>(null);

  // ---- Automated "claim this nick" flow (signed-in only) -----------
  //
  // claimState drives a small state machine in the UI:
  //   null        — idle; show the Claim button.
  //   'pending'   — spinner; show Cancel that aborts the in-flight
  //                 promise via the AbortController.
  //   'success'   — transient success message; auto-clears.
  //   'error'     — sticky error message until next Claim attempt.
  //
  // claimAbortRef holds the AbortController for the current in-flight
  // claim so the Cancel button can yank it from outside the async
  // closure that created it.
  const [claimState, setClaimState] = useState<{ kind: 'pending' | 'success' | 'error'; message: string } | null>(null);
  const claimAbortRef = useRef<AbortController | null>(null);

  // NickServ state-probe bookkeeping. `probing` shows a "checking…"
  // line; `probedForRef` dedupes the probe per (serverId, nonce) so it
  // runs once on open (and once per server — identity is network-local,
  // so switching servers re-probes that server's nick). Bumping
  // `redetectNonce` forces a fresh probe after an event that changes
  // the server-side state (e.g. a DROP) — using a dep (not just a ref
  // reset) so the effect is guaranteed to re-run regardless of whether
  // the status-wipe or the trigger lands first. Declared up here so
  // the drop handler can bump the nonce.
  const [probing, setProbing] = useState(false);
  const [redetectNonce, setRedetectNonce] = useState(0);
  const probedForRef = useRef<string | null>(null);

  // Copy the password field into the clipboard. Used for stashing
  // an auto-generated password somewhere durable (password manager)
  // before the field is masked again. Two-step UX:
  //   1. clipboard.writeText (modern browsers + Electron)
  //   2. flip passwordCopied for ~2s so the button label reads
  //      "Copied" and the user knows the write succeeded.
  const copyPasswordToClipboard = async (): Promise<void> => {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setPasswordCopied(true);
      setTimeout(() => setPasswordCopied(false), 2000);
    } catch {
      // Some sandboxed/insecure contexts deny clipboard access. Fall
      // back to selecting the password text inline so the user can
      // copy with Cmd/Ctrl-C. We force-show the field first because
      // a masked field can't be selected on most browsers.
      setPasswordShown(true);
    }
  };

  const handleClaimNick = async (): Promise<void> => {
    if (!onClaimNick) return;
    const acct = (accountName.trim() || creds?.accountName || myNick || '').trim();
    if (!acct) {
      setClaimState({ kind: 'error', message: 'Pick an account nick first.' });
      return;
    }
    // Tear down any prior in-flight claim before starting a fresh
    // one. Shouldn't normally happen because the button is disabled
    // while pending, but defence in depth.
    claimAbortRef.current?.abort();
    const ctrl = new AbortController();
    claimAbortRef.current = ctrl;

    setClaimState({ kind: 'pending', message: `Claiming ${acct} on this network…` });
    const result = await onClaimNick(acct, { signal: ctrl.signal });
    // If a newer claim has started since (somehow), don't overwrite
    // its state with ours. Identity-check via the ref.
    if (claimAbortRef.current !== ctrl) return;
    claimAbortRef.current = null;

    switch (result.kind) {
      case 'claimed':
        // The generated password just got persisted by ChatService.
        // Reveal it immediately and surface a sticky reminder — we
        // have no recovery path, so the user has to back it up now
        // or be locked out on the next device. The reminder doesn't
        // auto-clear (unlike the regular 5s flash); user dismisses
        // by closing the panel or starting another action.
        setPasswordShown(true);
        setClaimState({
          kind: 'success',
          message: `Claimed ${acct}. Generated password is shown below — copy it into a password manager now. We can't recover it for you.`,
        });
        break;
      case 'nick-taken':
        setClaimState({ kind: 'error', message: `${acct} is already registered on this network. Pick a different nick or identify against the existing account.` });
        break;
      case 'expired':
        setClaimState({ kind: 'error', message: 'Confirmation code never arrived. Try again or fall back to the manual form below.' });
        break;
      case 'cancelled':
        setClaimState(null);
        break;
      case 'unavailable':
        setClaimState({ kind: 'error', message: `Auto-claim unavailable: ${result.reason}. Use the manual register form below.` });
        break;
      case 'failed':
        setClaimState({ kind: 'error', message: `Claim failed: ${result.reason}` });
        break;
    }
  };

  const cancelClaim = (): void => {
    claimAbortRef.current?.abort();
    // The await above sees the cancel and sets state to null; no
    // need to set it here.
  };

  // Tear down the in-flight claim if the component unmounts (e.g.
  // user navigates away mid-flow).
  useEffect(() => {
    return () => { claimAbortRef.current?.abort(); };
  }, []);

  // Whether to render the Claim affordance at all. Requires both
  // a signed-in user AND the wiring being threaded — guests get
  // the existing manual form unchanged.
  const claimAvailable = Boolean(signedIn && onClaimNick);

  const onRegister = async (): Promise<void> => {
    if (!serverId) return;
    const pw = password.trim(), em = email.trim();
    if (!pw || !em) return;
    setRegisterStatus({ kind: 'pending', message: 'Registering…' });
    // Save creds + flag as 'registering' (transient). The classifier
    // will overwrite this with the real status once NickServ replies.
    // We save BEFORE firing so a reload mid-operation doesn't lose
    // the pending state.
    getServiceCredentialsStore().set(serverId, {
      ...(creds ?? {}),
      nickservPassword: pw,
      email: em,
      accountName: accountName.trim() || myNick || undefined,
      status: 'registering',
    });
    if (!onRegisterAccount) {
      // The button itself is gated on this prop being present
      // (see render). Defensive null-check to satisfy the linter.
      setRegisterStatus({ kind: 'error', message: 'Register is unavailable on this connection.' });
      return;
    }
    const result = await onRegisterAccount(pw, em);
    switch (result.kind) {
      case 'pending-confirmation':
        setRegisterStatus({ kind: 'success', message: `Check ${result.email} for a confirmation code.` });
        break;
      case 'registered':
        setRegisterStatus({ kind: 'success', message: 'Account registered. Auto-identifying…' });
        setTimeout(() => setRegisterStatus(null), 4000);
        break;
      case 'nick-taken':
        setRegisterStatus({ kind: 'error', message: 'That nick is already registered. Pick a different account name or identify against the existing one.' });
        break;
      case 'email-rejected':
        setRegisterStatus({ kind: 'error', message: `Email rejected: ${result.reason}` });
        break;
      case 'failed':
        setRegisterStatus({ kind: 'error', message: result.reason === 'timeout'
          ? 'Server never replied. Check the connection and try again.'
          : `Register failed: ${result.reason}` });
        break;
    }
  };

  // Inline feedback for CONFIRM outcomes (Step 7).
  const [confirmStatus, setConfirmStatus] = useState<{ kind: 'pending' | 'success' | 'error'; message: string } | null>(null);

  const onConfirm = async (): Promise<void> => {
    if (!serverId) return;
    const code = confirmCode.trim();
    if (!code) return;
    const acct = accountName.trim() || creds?.accountName || '';
    setConfirmStatus({ kind: 'pending', message: 'Confirming…' });
    if (!onConfirmAccount) {
      setConfirmStatus({ kind: 'error', message: 'Confirm is unavailable on this connection.' });
      return;
    }
    const result = await onConfirmAccount(acct, code);
    switch (result.kind) {
      case 'confirmed':
        setConfirmStatus({ kind: 'success', message: 'Account confirmed.' });
        setConfirmCode('');
        setTimeout(() => setConfirmStatus(null), 4000);
        break;
      case 'wrong-code':
        setConfirmStatus({ kind: 'error', message: 'Code rejected. Check your email for the correct one.' });
        break;
      case 'expired':
        setConfirmStatus({ kind: 'error', message: 'Code expired or no longer pending. Register again to get a fresh code.' });
        break;
      case 'failed':
        setConfirmStatus({ kind: 'error', message: result.reason === 'timeout'
          ? 'Server never replied. Check the connection and try again.'
          : `Confirm failed: ${result.reason}` });
        break;
    }
  };

  // Inline error message surfaced to the user when a drop fails for
  // a recoverable reason (wrong password, no such account, timeout).
  // Auto-clears when the user re-opens the confirm prompt.
  const [dropError, setDropError] = useState<string | null>(null);
  // Pending guard: prevents a double-click on "Yes, drop it" from
  // firing two parallel drop() calls. The race matters on Atheme,
  // where the server issues a single key per drop session — the
  // second replay sends a stale key and the server replies "Invalid
  // key for DROP", which is mystifying to the user.
  const [dropPending, setDropPending] = useState(false);

  // Transient identify status — "Identifying…" while the promise
  // is in flight, success/error message when it settles. Cleared
  // automatically after a success since the status badge already
  // reflects the outcome.
  const [identifyStatus, setIdentifyStatus] = useState<{ kind: 'pending' | 'success' | 'error'; message: string } | null>(null);

  const handleIdentifyNow = async (): Promise<void> => {
    const pw = (creds?.nickservPassword ?? '').trim();
    if (!pw) return;
    setIdentifyStatus({ kind: 'pending', message: 'Identifying…' });
    if (onIdentifyAccount) {
      const result = await onIdentifyAccount(pw);
      switch (result.kind) {
        case 'identified':
          setIdentifyStatus({ kind: 'success', message: 'Identified.' });
          // Hide the success indicator after a short moment so the
          // panel doesn't accumulate stale "Identified." labels.
          setTimeout(() => setIdentifyStatus(null), 3000);
          break;
        case 'identified-unconfirmed':
          setIdentifyStatus({ kind: 'success', message: 'Identified — confirm your email.' });
          break;
        case 'wrong-password':
          setIdentifyStatus({ kind: 'error', message: 'Password rejected. Update the saved password and try again.' });
          break;
        case 'no-such-account':
          setIdentifyStatus({ kind: 'error', message: 'No account by that name on this server.' });
          break;
        case 'failed':
          setIdentifyStatus({ kind: 'error', message: result.reason === 'timeout'
            ? 'Server never replied. Check the connection and try again.'
            : `Identify failed: ${result.reason}` });
          break;
      }
      return;
    }
    // Legacy fallback for callers that didn't thread the new prop.
    onTriggerAutoIdentify?.();
    setIdentifyStatus(null);
  };

  // Drop the registered account on the network. Calls into the new
  // AccountService path (Step 2 of the migration) when available —
  // that path owns the multi-step Anope dance internally and resolves
  // to a discrete DropResult. Falls back to the legacy adapter+classifier
  // path when the parent didn't thread the new handler through (e.g.
  // pre-migration callers, or Atheme/Ergo until Steps 3 + 4 land).
  const handleDropAccount = async (): Promise<void> => {
    if (!serverId) return;
    // Guard against double-fire (double-clicking "Yes, drop it").
    // Important on Atheme: the server issues a single second-step
    // key per drop session, so the duplicate replay sends a stale
    // key and the server replies "Invalid key for DROP" — surfaces
    // as `failed: invalid-key` and confuses the user.
    if (dropPending) return;
    const pw = (creds?.nickservPassword ?? password ?? '').trim();
    const acct = (accountName.trim() || creds?.accountName || myNick || '').trim();
    if (!acct) {
      setDropError('Enter the account name first.');
      return;
    }
    if (!pw) {
      setDropError('Type your NickServ password in the field above first — Anope/Atheme require it for DROP. (Ergo doesn’t, but the wire shape is the same.)');
      return;
    }
    setDropError(null);
    if (!onDropAccount) {
      setDropError('Drop is unavailable on this connection.');
      return;
    }
    setDropPending(true);
    try {
      const result = await onDropAccount(acct, pw);
      switch (result.kind) {
        case 'dropped':
          // ChatService's classifier path (drop-success kind) also
          // wipes the credentials store on the "has been dropped"
          // NickServ reply — the panel will re-render via the store
          // subscription. We just dismiss the confirm UI here.
          setDropConfirming(false);
          // The nick is now unregistered, so the cached probe result
          // is stale. Bump the nonce to force a fresh probe once the
          // store-wipe lands status back to undefined — it'll detect
          // 'no-account' and the Claim CTA reappears, instead of the
          // panel sitting on the pre-drop state.
          setRedetectNonce((n) => n + 1);
          break;
        case 'wrong-password':
          setDropError('Password was rejected. Save the correct one and try again.');
          break;
        case 'no-such-account':
          setDropError(`No account named "${acct}" on this server.`);
          break;
        case 'failed':
          if (result.reason === 'timeout') {
            setDropError('Server never replied. Check the connection and try again.');
          } else if (result.reason === 'invalid-key') {
            // Atheme's wrong second-step key. The first request
            // already consumed the key, so the user just needs to
            // start a fresh drop — clicking again resends the
            // first-step DROP and the server issues a new key.
            setDropError('Server-issued key was rejected — click Drop again to retry with a fresh key.');
          } else {
            setDropError(`Drop failed: ${result.reason}`);
          }
          break;
      }
    } finally {
      setDropPending(false);
    }
  };

  // Probe NickServ for the current account state. INFO is the most
  // portable verb — both Atheme and Anope return a multi-line block
  // including identification + confirmation state. Reply flows
  // through the normal classifier path and onto ~server, so the user
  // can read it directly; the classifier also picks up "you are
  // already identified" / "isn't registered" etc. and flips the
  // badge.
  const onCheckStatus = (): void => {
    if (!onRunCommand) return;
    const acct = (accountName.trim() || creds?.accountName || myNick || '').trim();
    if (!acct) return;
    onRunCommand(getAdapter(servicesFramework).buildInfo(acct));
  };

  // Resend the confirmation email (Anope-only). The new
  // AccountService path resolves to {kind:'sent'} / 'cooldown' /
  // 'failed' / 'unsupported' — we surface 'sent' as a transient
  // success toast and persist 'cooldown' to the creds store so the
  // button stays disabled across reloads (matching the legacy
  // resendCooldownUntil behaviour).
  //
  // Falls back to the legacy fire-and-forget path when the new prop
  // isn't threaded (mid-migration compatibility).
  const onResend = (() => {
    if (!onResendConfirmation) return null;
    if (supportsResend === false) return null;
    const acct = (accountName.trim() || creds?.accountName || myNick || '').trim();
    if (!acct) return null;
    return async () => {
      const result = await onResendConfirmation(acct);
      if (result.kind === 'cooldown' && serverId) {
        const store = getServiceCredentialsStore();
        const existing = store.get(serverId) ?? {};
        store.set(serverId, {
          ...existing,
          resendCooldownUntil: Date.now() + result.retryAfterMs,
        });
      }
      // 'sent' is handled by the badge / chat-area notice path;
      // 'unsupported' shouldn't reach here (supportsResend gates it).
    };
  })();

  const status = creds?.status;

  // States where the nick is known to be registered (to us) — Claim is
  // hidden because the Confirm form (pending/unconfirmed) or the
  // Identify form (registered/identified) is the right next step.
  // Everything else (no-account, undefined, unknown, identify-failed)
  // lets a signed-in user attempt the automated claim.
  const claimHiddenByState =
    status === 'registering' ||
    status === 'pending-confirmation' ||
    status === 'identified' ||
    status === 'identified-unconfirmed' ||
    status === 'registered';

  // The on-open probe should only suppress the Claim CTA while the
  // state is genuinely unknown. Once status resolves to anything
  // definite (e.g. 'no-account'), a stale/in-flight `probing` flag
  // must not keep hiding Claim — that was the "signed-in but no Claim"
  // bug. So we only treat it as "still detecting" when status is also
  // unknown.
  const stillDetecting = probing && (status === undefined || status === 'unknown');

  // Auto-probe NickServ when we're in an in-flight registration
  // state. Fires INFO 5s after entering 'registering' or
  // 'pending-confirmation' so the badge updates without a manual
  // click — the user came back to a stale screen after checking
  // email, the classifier handles the reply, status flips. The
  // 5s delay lets the original REGISTER finish server-side before
  // we ask, and debounces against the user typing in the
  // accountName field (the effect re-arms on every keystroke).
  useEffect(() => {
    if (!onRunCommand) return;
    if (
      status !== 'registering' &&
      status !== 'pending-confirmation' &&
      status !== 'identified-unconfirmed'
    ) return;
    const acct = (accountName.trim() || creds?.accountName || myNick || '').trim();
    if (!acct) return;
    const adapter = getAdapter(servicesFramework);
    const t = setTimeout(() => {
      onRunCommand(adapter.buildInfo(acct));
    }, 5000);
    return () => clearTimeout(t);
  }, [status, accountName, creds?.accountName, myNick, onRunCommand, servicesFramework]);

  // Probe NickServ once on open to learn whether the nick is
  // registered / confirmed, so we show the right CTA instead of
  // optimistically offering Register and bouncing off `nick-taken`.
  // Only fires when we don't already have a meaningful status; the
  // ref dedupes so an indeterminate probe (status stays unknown)
  // doesn't loop. detectAccountState writes the resolved status into
  // the creds store, which flows back here via the subscription.
  useEffect(() => {
    if (!onDetectAccountState || !serverId) return;
    if (status !== undefined && status !== 'unknown') return;
    const key = `${serverId}:${redetectNonce}`;
    if (probedForRef.current === key) return;
    probedForRef.current = key;
    setProbing(true);
    // Always clear probing when the probe settles. (Earlier this was
    // gated on a not-cancelled flag, but the effect re-runs the instant
    // detectAccountState writes the resolved status — that cleanup set
    // cancelled=true and the .finally then skipped setProbing(false),
    // stranding probing=true and hiding the Claim CTA forever. The
    // re-run returns early without starting a new probe, so there's no
    // competing probe to protect against.)
    void onDetectAccountState()
      .catch(() => undefined)
      .finally(() => setProbing(false));
  }, [serverId, status, onDetectAccountState, redetectNonce]);

  // Auto-resume a stranded confirmation: when the nick is registered-
  // but-unconfirmed and a backend claim is still pending, the email
  // code was likely already captured — finish CONFIRM automatically
  // rather than making the user paste it. Deduped per claim id. On
  // 'still-pending' (POP3 hasn't captured a code yet) we clear the
  // spinner and leave the manual paste/resend form in place.
  const resumedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onResumeConfirmation) return;
    if (status !== 'pending-confirmation') return;
    const claimId = creds?.pendingRegistration?.id;
    if (!claimId) return;
    if (resumedForRef.current === claimId) return;
    resumedForRef.current = claimId;

    const ac = new AbortController();
    setConfirmStatus({ kind: 'pending', message: 'Finishing confirmation…' });
    void onResumeConfirmation(undefined, { signal: ac.signal })
      .then((r) => {
        switch (r.kind) {
          case 'confirmed':
            setConfirmStatus({ kind: 'success', message: 'Account confirmed.' });
            setTimeout(() => setConfirmStatus(null), 4000);
            break;
          case 'wrong-code':
            setConfirmStatus({ kind: 'error', message: 'The emailed code was rejected. Paste it manually or resend below.' });
            break;
          case 'expired':
            setConfirmStatus({ kind: 'error', message: 'Confirmation expired before a code arrived. Register again to get a fresh code.' });
            break;
          case 'still-pending':
          case 'unavailable':
            // Nothing captured yet / nothing to resume — fall back to
            // the manual confirm form without a sticky error.
            setConfirmStatus(null);
            break;
          default:
            setConfirmStatus({ kind: 'error', message: `Couldn't finish confirmation: ${r.reason}` });
        }
      })
      .catch(() => setConfirmStatus(null));
    return () => { ac.abort(); };
  }, [status, creds?.pendingRegistration?.id, onResumeConfirmation]);

  return (
    <SectionFrame
      title="Identity"
      description="Your nick + NickServ account on this network."
    >
      <Card>
        <div class="server-settings-card-body">
          {/* --- Current nick + change-nick ----------------------- */}
          <DetailRow label="Nick" value={myNick} />
          {onChangeNick && (
            <form class="server-settings-nick-form" onSubmit={submitNick}>
              <Field
                label="Change nick"
                hint="Server may reject duplicates or invalid characters; you'll see an error banner if it does."
              >
                <Input
                  value={nickDraft}
                  onInput={(e) => setNickDraft((e.target as HTMLInputElement).value)}
                  autoComplete="off"
                  spellcheck={false}
                />
              </Field>
              <Button
                type="submit"
                variant="primary"
                disabled={!nickDraft.trim() || nickDraft.trim() === myNick}
              >
                Save
              </Button>
            </form>
          )}

          {/* --- Account section starts here. Everything below is
              the NickServ account flow; the visual divider tells
              the user where "nick" ends and "account" begins. */}
          <Divider />

          {!serverId ? (
            <p class="server-settings-empty">
              Saved account credentials need a stable server id. Reconnect from the directory to enable this section.
            </p>
          ) : (
            <>
              <div class="services-creds-status-row">
                <DetailRow label="Services" customValue={
                  <span class="server-settings-services-fw">
                    <Badge tone={servicesFramework === 'atheme' || servicesFramework === 'anope' || servicesFramework === 'ergo' ? 'info' : 'warn'}>
                      {frameworkLabel(servicesFramework)}
                    </Badge>
                  </span>
                } />
                <DetailRow label="Account" customValue={
                  <span class="server-settings-services-fw">
                    <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>
                  </span>
                } />
              </div>

              <ServicesStatusPanel
                status={status}
                accountName={creds?.accountName || myNick}
                email={creds?.email}
                confirmCode={confirmCode}
                setConfirmCode={setConfirmCode}
                onConfirm={() => { void onConfirm(); }}
                confirmDisabled={!onConfirmAccount || confirmStatus?.kind === 'pending'}
                confirmStatus={confirmStatus}
                onResend={onResend}
                resendCooldownUntil={creds?.resendCooldownUntil}
              />

              {/* Signed-in users get cross-device sync of this password,
                  end-to-end encrypted (the server can't read it). */}
              {signedIn && (
                <p class="services-creds-status-msg services-creds-status-msg-info">
                  🔒 Saved here syncs (end-to-end encrypted) to your Boson account, so your
                  NickServ password follows you to other devices.
                </p>
              )}

              {/* Automated claim flow for signed-in users. We HIDE
                  Claim only when we positively know the nick is
                  registered-ish — a registered-but-unconfirmed nick
                  shows the Confirm form above, a confirmed one shows
                  the Identify form below. For every other state
                  (no-account, undefined, unknown, identify-failed) a
                  signed-in user gets the Claim button: the original
                  bug was offering Claim on an *already-registered* nick,
                  not hiding it whenever detection was merely
                  inconclusive. While the on-open probe is in flight we
                  show a "checking…" line instead of flashing Claim. */}
              {claimAvailable && stillDetecting && (
                <p class="services-creds-status-msg services-creds-status-msg-info">
                  Checking <code>{(accountName.trim() || creds?.accountName || myNick || '').trim()}</code>'s
                  account status on this network…
                </p>
              )}
              {claimAvailable && !stillDetecting && !claimHiddenByState && (
                <ClaimNickCard
                  state={claimState}
                  accountName={(accountName.trim() || creds?.accountName || myNick || '').trim()}
                  onClaim={() => { void handleClaimNick(); }}
                  onCancel={cancelClaim}
                />
              )}

              <form onSubmit={onSaveCreds} class="user-settings-form">
                <Field
                  label="Account nick"
                  hint={`The nick your NickServ account is registered under. Defaults to ${myNick || 'your current nick'}.`}
                >
                  <Input
                    value={accountName}
                    onInput={(e) => setAccountName((e.target as HTMLInputElement).value)}
                    placeholder={myNick}
                    autoComplete="off"
                    spellcheck={false}
                  />
                </Field>
                <Field
                  label="Password"
                  hint={password
                    ? 'Stored locally only — back it up in a password manager. We have no recovery path.'
                    : 'Stored locally in plain text. Auto-sent as IDENTIFY after the server welcomes us.'}
                >
                  <div class="server-settings-password-row">
                    <Input
                      type={passwordShown ? 'text' : 'password'}
                      value={password}
                      onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
                      autoComplete="off"
                      spellcheck={false}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setPasswordShown((v) => !v)}
                      disabled={!password}
                      title={passwordShown ? 'Hide password' : 'Show password'}
                    >
                      {passwordShown ? 'Hide' : 'Show'}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => { void copyPasswordToClipboard(); }}
                      disabled={!password}
                      title="Copy password to clipboard"
                    >
                      {passwordCopied ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                </Field>
                <Field
                  label="Email"
                  hint="Many networks require an email at REGISTER time and again to CONFIRM. Saved so we can remind you what address received the code."
                >
                  <Input
                    value={email}
                    onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
                    placeholder="you@example.com"
                    autoComplete="off"
                    spellcheck={false}
                  />
                </Field>
                <div class="user-settings-form-actions">
                  {savedFlash && <span class="user-settings-saved">Saved</span>}
                  <Button type="submit" variant="primary">Save</Button>
                  {creds?.nickservPassword && (onIdentifyAccount || onTriggerAutoIdentify) && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => { void handleIdentifyNow(); }}
                      disabled={identifyStatus?.kind === 'pending'}
                    >
                      {identifyStatus?.kind === 'pending' ? 'Identifying…' : 'Identify now'}
                    </Button>
                  )}
                  {(accountName.trim() || creds?.accountName || myNick) && (
                    <Button type="button" variant="ghost" onClick={onCheckStatus} disabled={!onRunCommand}>
                      Check status
                    </Button>
                  )}
                  {password.trim() && email.trim() && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => { void onRegister(); }}
                      disabled={!onRegisterAccount || registerStatus?.kind === 'pending'}
                    >
                      {registerStatus?.kind === 'pending' ? 'Registering…' : 'Register new account'}
                    </Button>
                  )}
                  {creds && (creds.nickservPassword || creds.email || creds.accountName) && (
                    <Button type="button" variant="ghost" onClick={onClearCreds}>Clear</Button>
                  )}
                </div>
                {identifyStatus && identifyStatus.kind !== 'pending' && (
                  <p
                    class={`server-settings-identify-feedback server-settings-identify-${identifyStatus.kind}`}
                    role={identifyStatus.kind === 'error' ? 'alert' : 'status'}
                  >
                    {identifyStatus.message}
                  </p>
                )}
                {registerStatus && registerStatus.kind !== 'pending' && (
                  <p
                    class={`server-settings-identify-feedback server-settings-identify-${registerStatus.kind}`}
                    role={registerStatus.kind === 'error' ? 'alert' : 'status'}
                  >
                    {registerStatus.message}
                  </p>
                )}
                {/* Destructive: irreversible network-side delete. Two-
                    state inline confirm — first click reveals the
                    confirm/cancel pair, so a misclick can't drop the
                    account. Visible whenever an account name is known
                    (typed, saved, or matching the current nick) — the
                    handler surfaces a clear error if the password
                    isn't saved yet, instead of silently hiding the
                    button. (Previously gated on a saved password,
                    which made the button vanish exactly when the
                    user most needed it — e.g. after a failed claim
                    where the password was never persisted.) */}
                {(accountName.trim() || creds?.accountName || myNick) && (
                  <>
                    <DropAccountRow
                      confirming={dropConfirming}
                      onAsk={() => { setDropError(null); setDropConfirming(true); }}
                      onConfirm={() => { void handleDropAccount(); }}
                      onCancel={() => { setDropError(null); setDropConfirming(false); }}
                      accountName={accountName.trim() || creds?.accountName || myNick}
                      disabled={!onDropAccount}
                      pending={dropPending}
                    />
                    {dropError && (
                      <p class="server-settings-drop-error" role="alert">{dropError}</p>
                    )}
                  </>
                )}
              </form>
            </>
          )}
        </div>
      </Card>
    </SectionFrame>
  );
}

// Icon/banner upload control for the owner's Edit panel. Square variant
// previews via <Avatar>; banner variant shows a wide preview. Validates
// type + size client-side, then delegates to onSave (upload) / onSave(null)
// (remove).
function ServerImageControl({ kind, label, hint, currentUrl, fallbackName, variant, onSave }: {
  kind: 'icon' | 'banner';
  label: string;
  hint: string;
  currentUrl?: string;
  fallbackName: string;
  variant: 'square' | 'banner';
  onSave: (kind: 'icon' | 'banner', image: Blob | null) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const run = (fn: () => Promise<void>): void => {
    setBusy(true);
    setError(null);
    fn()
      .catch((err) => {
        if (err instanceof HttpError && err.status === 503) setError('Image storage isn’t available.');
        else if (err instanceof HttpError && err.status === 413) setError('Image is too large (max 5 MB).');
        else if (err instanceof HttpError && err.status === 400) setError('That file isn’t a supported image.');
        else if (err instanceof HttpError && err.status === 403) setError('Only the listing owner can change this.');
        else setError('Failed — try again.');
      })
      .finally(() => setBusy(false));
  };

  const pick = (e: Event): void => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { setError('Please choose an image file.'); return; }
    if (file.size > 5 * 1024 * 1024) { setError('Image must be under 5 MB.'); return; }
    run(() => onSave(kind, file));
  };

  return (
    <Field label={label} hint={hint}>
      <div class="server-image-control">
        {variant === 'square' ? (
          <Avatar nick={fallbackName} url={currentUrl} size={56} />
        ) : (
          <div class="server-image-banner-preview">
            {currentUrl ? <img src={currentUrl} alt="" /> : <span>No banner</span>}
          </div>
        )}
        <div class="server-image-actions">
          <input ref={fileRef} type="file" accept="image/*" style="display:none" onChange={pick} />
          <Button type="button" variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? 'Working…' : (currentUrl ? 'Change' : 'Upload')}
          </Button>
          {currentUrl && (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => run(() => onSave(kind, null))}>
              Remove
            </Button>
          )}
        </div>
      </div>
      {error && <div class="server-settings-error">{error}</div>}
    </Field>
  );
}

function EditProfileSection({
  entry,
  onSave,
  onSaveImage,
}: {
  entry: DirectoryEntryProfile;
  onSave: (patch: Partial<DirectoryEntryProfile>) => Promise<void>;
  onSaveImage?: (kind: 'icon' | 'banner', image: Blob | null) => Promise<void>;
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
      {onSaveImage && (
        <Card>
          <div class="server-settings-images">
            <ServerImageControl
              kind="icon" label="Icon" hint="Square. Shown in the directory grid + server rail."
              currentUrl={entry.iconUrl} fallbackName={entry.name} variant="square"
              onSave={onSaveImage}
            />
            <ServerImageControl
              kind="banner" label="Banner" hint="Wide (3:1). Shown atop the listing."
              currentUrl={entry.bannerUrl} fallbackName={entry.name} variant="banner"
              onSave={onSaveImage}
            />
          </div>
        </Card>
      )}
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

// "Operators" — owner-only operator management. The mechanism differs by
// services package (getAdapter(...).operMode):
//   * Anope ('live'): drive OperServ OPER ADD/DEL/LIST directly. Anope
//     persists the list and auto-grants services-oper when the account
//     identifies, so a Boson member opers with NO password. Management
//     commands require the caller to already hold operator privilege, so
//     the controls are gated on `isOper` (numeric 381 / self +o).
//   * Atheme / Ergo ('config'): no runtime grant exists — we generate an
//     operator{} / opers: config block for the owner to paste + rehash.
//
// NOTE: `isOper` is IRCd-oper status, which on Anope is distinct from the
// services-oper privilege OperServ actually checks — a services-oper can
// manage opers without holding +o. The gate is therefore a guard rail; the
// captured OperServ reply ("Access denied" vs success) is authoritative.
interface OperatorsSectionProps {
  servicesFramework: 'atheme' | 'anope' | 'ergo' | 'unknown' | null;
  isOper: boolean;
  onRunCommand?: (line: string) => void;
  serverLog: ReadonlyArray<ServerLogEntry>;
}

function OperatorsSection({ servicesFramework, isOper, onRunCommand, serverLog }: OperatorsSectionProps) {
  const adapter = getAdapter(servicesFramework);

  if (adapter.operMode === 'config') {
    return (
      <SectionFrame
        title="Operators"
        description={`${frameworkLabel(servicesFramework)} grants operators through config, not a runtime command. Generate a block below, paste it into your server config, and rehash.`}
      >
        <OperatorConfigCard adapter={adapter} framework={servicesFramework} />
      </SectionFrame>
    );
  }

  // Live (Anope). Gate the management controls on operator status: pass
  // onRunCommand only when we're opered, so the Capturing* components'
  // own disabled-when-no-handler logic blocks ADD/DEL/LIST otherwise.
  const gatedRun = isOper ? onRunCommand : undefined;
  return (
    <SectionFrame
      title="Operators"
      description="Grant operator access to a member's services account. Once added, they're opered automatically when they identify — no password needed."
    >
      <Card>
        <div class="server-settings-oper-status">
          <Badge tone={isOper ? 'success' : 'warn'}>
            {isOper ? 'Operator' : 'Not a network operator'}
          </Badge>
          {!isOper && (
            <p class="server-settings-cmd-hint">
              You need operator privilege to manage opers. Run <code>/oper &lt;name&gt; &lt;password&gt;</code>{' '}
              or identify to your oper account, then reopen this tab.
            </p>
          )}
        </div>
        <Divider />
        <CapturingTwoArgCommand
          label="Add operator"
          hint="Account name + oper type (must match a type your network defines, e.g. Services Operator)."
          placeholders={['account', 'oper type']}
          buttonLabel="Add"
          buildCommand={(account, type) => adapter.buildOperAdd?.(account, type) ?? ''}
          onRunCommand={gatedRun}
          serverLog={serverLog}
          search=""
        />
        <CapturingOneArgCommand
          label="Remove operator"
          hint="Revoke operator access for an account."
          placeholder="account"
          buttonLabel="Remove"
          buildCommand={(account) => adapter.buildOperDel?.(account) ?? ''}
          onRunCommand={gatedRun}
          serverLog={serverLog}
          search=""
        />
        <CapturingNullaryCommand
          label="List operators"
          hint="Show the current operator roster."
          buttonLabel="List"
          command={adapter.buildOperList?.() ?? ''}
          onRunCommand={gatedRun}
          serverLog={serverLog}
          search=""
        />
      </Card>
    </SectionFrame>
  );
}

// Config-mode (Atheme/Ergo) operator block generator. Controlled account +
// type inputs render a paste-ready block; a Copy button writes it to the
// clipboard. Sends nothing on the wire.
function OperatorConfigCard({
  adapter, framework,
}: {
  adapter: ServicesAdapter;
  framework: 'atheme' | 'anope' | 'ergo' | 'unknown' | null;
}) {
  const [account, setAccount] = useState('');
  const [type, setType] = useState('');
  const [copied, setCopied] = useState(false);
  const block = account.trim() && adapter.buildOperConfig
    ? adapter.buildOperConfig(account.trim(), type.trim() || 'operator')
    : '';
  const target = framework === 'ergo' ? 'ircd.yaml' : 'atheme.conf';
  const copy = async (): Promise<void> => {
    if (!block) return;
    try {
      await navigator.clipboard.writeText(block);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied (sandboxed context) — the block is on-screen and
      // selectable, so the user can still copy it manually.
    }
  };
  return (
    <Card>
      <div class="server-settings-cmd-controls server-settings-cmd-controls-two">
        <Input
          value={account}
          onInput={(e) => setAccount((e.target as HTMLInputElement).value)}
          placeholder="account"
          autoComplete="off"
          spellcheck={false}
        />
        <Input
          value={type}
          onInput={(e) => setType((e.target as HTMLInputElement).value)}
          placeholder="operclass / class"
          autoComplete="off"
          spellcheck={false}
        />
      </div>
      {block && (
        <>
          <pre class="server-settings-cmd-output">{block}</pre>
          <div class="server-settings-oper-config-actions">
            <span class="server-settings-cmd-hint">Paste into <code>{target}</code> and rehash.</span>
            <Button type="button" variant="secondary" size="sm" onClick={() => { void copy(); }}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

// Per-server bouncer routing. Toggles whether THIS connection goes through the
// user's global ZNC profile (configured in User Settings → Bouncer) and names
// the ZNC network this server maps to. Takes effect on the next (re)connect.
function BouncerServerSection({ route, globallyEnabled, onSave }: {
  route?: { route: boolean; network: string };
  globallyEnabled: boolean;
  onSave?: (route: { route: boolean; network: string }) => void;
}) {
  const [on, setOn] = useState(route?.route ?? false);
  const [network, setNetwork] = useState(route?.network ?? '');
  const [saved, triggerSaved] = useTransientFlag();

  const submit = (e: Event): void => {
    e.preventDefault();
    onSave?.({ route: on, network: network.trim() });
    triggerSaved();
  };

  return (
    <SectionFrame
      title="Bouncer"
      description="Route this server through your ZNC/BNC bouncer instead of connecting to it directly. Reconnect for changes to take effect."
    >
      <Card>
        <form onSubmit={submit} class="server-settings-card-body">
          {!globallyEnabled && (
            <p class="server-settings-cmd-hint">
              No bouncer is enabled yet. Configure one in <strong>User Settings → Bouncer</strong>{' '}
              first — this toggle has no effect until then.
            </p>
          )}
          <Toggle checked={on} onChange={setOn} label="Route this server through the bouncer" />
          <Field
            label="ZNC network name"
            hint="The network configured in ZNC, e.g. libera. Leave blank to use your bouncer's default network."
          >
            <Input
              value={network}
              onInput={(e) => setNetwork((e.target as HTMLInputElement).value)}
              placeholder="libera"
              autoComplete="off"
              spellcheck={false}
              disabled={!onSave}
            />
          </Field>
          <div class="server-settings-oper-config-actions">
            {saved && <span class="user-settings-saved">Saved — reconnect to apply</span>}
            <Button type="submit" variant="primary" disabled={!onSave}>Save</Button>
          </div>
        </form>
      </Card>
    </SectionFrame>
  );
}

interface AdvancedSectionProps {
  myNick: string;
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
// Advanced is the raw-commands playground. The status-aware account
// management UI (password, email, register, confirm) lives on the
// Identity section instead — that's what users expect, and the menu
// item literally says "Your nick + NickServ account". Advanced still
// has a NickServ tab for the raw `/msg NickServ ...` forms (IDENTIFY
// with a typed password, INFO, GHOST, SET *), which is useful for
// power users debugging an account or invoking commands outside the
// Identity flow.
type AdvancedTabId =
  | 'nickserv'
  | 'account'
  | 'lookups'
  | 'chanserv'
  | 'modes'
  | 'server'
  | 'memos'
  | 'cloak';

const ADVANCED_TABS: ReadonlyArray<{ id: AdvancedTabId; label: string }> = [
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
  myNick, onRunCommand, serverLog,
}: AdvancedSectionProps) {
  // Search filters within the active tab. When the box has any content
  // we ALSO render every other tab's subsection below (each hides
  // itself if no rows match), so a query the user typed for "kick"
  // surfaces hits no matter which tab they happened to be on. The
  // active tab still renders even when empty after filter — gives the
  // user feedback that this tab has no matches.
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<AdvancedTabId>('nickserv');
  const subProps = { onRunCommand, serverLog, search };
  const renderTab = (id: AdvancedTabId): ComponentChildren => {
    switch (id) {
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

// ---- Account / Identity helpers ----------------------------------------
//
// Used inline by `IdentitySection` (where the account UI lives). Kept
// as free functions rather than inlined helpers so the status mapping
// can be unit-tested independently of the renderer.

// Resolve a human label for a saved AccountStatus. Centralised so the
// badge + the status-driven copy block agree on wording.
function statusLabel(status: AccountStatus | undefined): string {
  switch (status) {
    case 'identified':              return 'Identified';
    case 'identified-unconfirmed':  return 'Identified — confirm your email';
    case 'registering':             return 'Registering…';
    case 'pending-confirmation':    return 'Confirm your email';
    case 'identify-failed':         return 'Identify failed';
    case 'registered':              return 'Saved — will auto-identify';
    case 'no-account':              return 'No account';
    case 'unknown':                 return 'Unknown';
    default:                        return 'Not connected yet';
  }
}

// Tone for the status badge. `identified` is the calm green-ish "info";
// `identify-failed` is the alarming red; pending is the friendly
// amber/warn. Other states are neutral.
function statusTone(status: AccountStatus | undefined): 'info' | 'warn' | 'danger' | 'success' {
  switch (status) {
    case 'identified':              return 'success';
    case 'identified-unconfirmed':  return 'warn';
    case 'identify-failed':         return 'danger';
    case 'pending-confirmation':    return 'warn';
    case 'registering':             return 'warn';
    default:                        return 'info';
  }
}

interface ServicesStatusPanelProps {
  status: AccountStatus | undefined;
  accountName: string;
  email?: string;
  confirmCode: string;
  setConfirmCode: (s: string) => void;
  onConfirm: () => void;
  confirmDisabled: boolean;
  // Step 7 — inline feedback for the CONFIRM operation. When set,
  // rendered below the code input.
  confirmStatus?: { kind: 'pending' | 'success' | 'error'; message: string } | null;
  // Resend affordance. `onResend` is null on packages that have
  // no upstream resend (Atheme, Ergo) — the button is hidden in
  // that case. `resendCooldownUntil` is the epoch-ms after which
  // the button re-enables; when in the past, the button is live.
  onResend: (() => void) | null;
  resendCooldownUntil?: number;
}

// Status-driven copy + actions above the form. Each AccountStatus
// gets a tailored block: identified shows "Signed in as X" with a
// muted tone; pending-confirmation shows the code input; failed
// shows a red banner; the empty states show a friendly hint.
function ServicesStatusPanel({
  status, accountName, email, confirmCode, setConfirmCode, onConfirm, confirmDisabled,
  confirmStatus, onResend, resendCooldownUntil,
}: ServicesStatusPanelProps) {
  // Renders below the confirm form in both pending-confirmation and
  // identified-unconfirmed states.
  const confirmFeedback = confirmStatus && confirmStatus.kind !== 'pending' ? (
    <p
      class={`server-settings-identify-feedback server-settings-identify-${confirmStatus.kind}`}
      role={confirmStatus.kind === 'error' ? 'alert' : 'status'}
    >
      {confirmStatus.message}
    </p>
  ) : null;
  if (status === 'identified') {
    return (
      <p class="services-creds-status-msg services-creds-status-msg-ok">
        Identified as <code>{accountName}</code>.
      </p>
    );
  }
  if (status === 'identify-failed') {
    return (
      <p class="services-creds-status-msg services-creds-status-msg-error">
        Last identify was rejected. The password may be wrong, or the account doesn't exist on this network.
      </p>
    );
  }
  // Identified, but the account itself is unconfirmed — common on
  // Anope between REGISTER and CONFIRM. The user IS logged in and
  // can chat; we just nag them to finish the email step before the
  // account expires (~24h on most networks). Same confirm-code
  // input as the pending state, but the banner copy reflects that
  // the identify itself worked.
  if (status === 'identified-unconfirmed') {
    return (
      <div class="services-creds-status-pending">
        <p class="services-creds-status-msg services-creds-status-msg-warn">
          Identified as <code>{accountName}</code>{email ? <> ({email})</> : ''}, but the
          account hasn't been email-confirmed yet. Paste the code from your inbox to finish —
          most networks expire unconfirmed accounts within 24 hours.
        </p>
        <form
          class="services-creds-confirm-row"
          onSubmit={(e) => { e.preventDefault(); onConfirm(); }}
        >
          <Input
            value={confirmCode}
            onInput={(e) => setConfirmCode((e.target as HTMLInputElement).value)}
            placeholder="paste the code from your email"
            autoComplete="off"
            spellcheck={false}
          />
          <Button type="submit" variant="primary" disabled={confirmDisabled || !confirmCode.trim()}>
            {confirmStatus?.kind === 'pending' ? 'Confirming…' : 'Confirm'}
          </Button>
          <ResendButton onResend={onResend} cooldownUntil={resendCooldownUntil} />
        </form>
        {confirmFeedback}
      </div>
    );
  }
  // `registering` (we fired REGISTER, no terminal reply yet) and
  // `pending-confirmation` (classifier saw "please confirm") both
  // surface the same affordance: a code input the user can paste
  // into. This matters because the optimistic flow can land you in
  // 'registering' even though an email with a code already arrived
  // — and the user wants to type the code regardless of what our
  // local status thinks.
  if (status === 'registering' || status === 'pending-confirmation') {
    return (
      <div class="services-creds-status-pending">
        <p class="services-creds-status-msg services-creds-status-msg-warn">
          {status === 'registering' ? (
            <>Registering <code>{accountName}</code>{email ? <> with <code>{email}</code></> : ''}…
            waiting for NickServ. If you already received a confirmation code by email, paste it below:</>
          ) : (
            <>Registered <code>{accountName}</code>{email ? <> with <code>{email}</code></> : ''}.
            Check your inbox for a confirmation code, then enter it here:</>
          )}
        </p>
        <form
          class="services-creds-confirm-row"
          onSubmit={(e) => { e.preventDefault(); onConfirm(); }}
        >
          <Input
            value={confirmCode}
            onInput={(e) => setConfirmCode((e.target as HTMLInputElement).value)}
            placeholder="paste the code from your email"
            autoComplete="off"
            spellcheck={false}
          />
          <Button type="submit" variant="primary" disabled={confirmDisabled || !confirmCode.trim()}>
            {confirmStatus?.kind === 'pending' ? 'Confirming…' : 'Confirm'}
          </Button>
          <ResendButton onResend={onResend} cooldownUntil={resendCooldownUntil} />
        </form>
        {confirmFeedback}
      </div>
    );
  }
  if (status === 'registered') {
    return (
      <p class="services-creds-status-msg services-creds-status-msg-info">
        Credentials saved. Auto-IDENTIFY will run on the next connect.
      </p>
    );
  }
  // unknown / no-account / undefined — first-time hint.
  return (
    <p class="services-creds-status-msg services-creds-status-msg-info">
      No account saved for this server yet. Fill in a password + email below and click
      <strong> Register new account </strong> to create one — or fill in just a password and click
      <strong> Save </strong> if you already have one.
    </p>
  );
}

// "Resend confirmation email" affordance shown inline with the
// confirm-code input. Hidden when `onResend` is null — that's the
// signal from the adapter that this services package has no
// upstream resend command (Atheme, Ergo). When a cooldown is
// active, button is disabled and the title attribute carries the
// human countdown so a hover reveals "Try again in N min".
//
// Uses a tick to re-render once a second so the countdown stays
// fresh and the button auto-re-enables when the cooldown expires
// without requiring a parent prop change.
function ResendButton({
  onResend, cooldownUntil,
}: {
  onResend: (() => void) | null;
  cooldownUntil?: number;
}) {
  if (!onResend) return null;
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!cooldownUntil || cooldownUntil <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [cooldownUntil]);
  const remainingMs = (cooldownUntil ?? 0) - now;
  const cooling = remainingMs > 0;
  const remainingMin = Math.ceil(remainingMs / 60_000);
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onResend}
      disabled={cooling}
      title={cooling ? `Server is rate-limited — try again in ${remainingMin} min` : 'Re-send the confirmation email'}
    >
      {cooling ? `Resend (${remainingMin}m)` : 'Resend email'}
    </Button>
  );
}

// ClaimNickCard is the signed-in-user affordance for the automated
// "claim this nick" flow. Shown above the manual register form so
// a signed-in user gets the one-click path by default while the
// manual form remains as an escape hatch.
//
// Owns no business logic — just renders the right button + state
// for whatever the parent's claim machine is doing. Parent owns
// the AbortController.
function ClaimNickCard({
  state, accountName, onClaim, onCancel,
}: {
  state: { kind: 'pending' | 'success' | 'error'; message: string } | null;
  accountName: string;
  onClaim: () => void;
  onCancel: () => void;
}) {
  return (
    <div class="services-claim-card">
      <p class="services-claim-hint">
        Boson can register <code>{accountName}</code> on this network for you
        — we'll generate a password and handle the confirmation email behind
        the scenes. Or fill in the form below to do it manually.
      </p>
      <div class="services-claim-actions">
        {state?.kind === 'pending' ? (
          <>
            <Button type="button" variant="secondary" disabled>
              {state.message}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </>
        ) : (
          <Button type="button" variant="primary" onClick={onClaim}>
            Claim <code>{accountName}</code> on this network
          </Button>
        )}
      </div>
      {state && state.kind !== 'pending' && (
        <p
          class={`server-settings-identify-feedback server-settings-identify-${state.kind}`}
          role={state.kind === 'error' ? 'alert' : 'status'}
        >
          {state.message}
        </p>
      )}
    </div>
  );
}

// Inline destructive action: drop the account on the network. Two-
// state — first click on "Drop account" asks for confirmation; the
// second click fires the DROP command. Cancel is always available
// while confirming. Parent owns the `confirming` flag so changing
// servers / clearing creds resets the prompt for free.
function DropAccountRow({
  confirming, onAsk, onConfirm, onCancel, accountName, disabled, pending,
}: {
  confirming: boolean;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  accountName: string;
  disabled: boolean;
  // True while a drop() operation is in flight. Disables the
  // "Yes, drop it" button so a double-click can't fire two parallel
  // requests (which on Atheme would land the second one with a
  // stale server-issued key → "Invalid key for DROP").
  pending: boolean;
}) {
  if (!confirming) {
    return (
      <div class="services-creds-drop-row">
        <Button type="button" variant="ghost" onClick={onAsk} disabled={disabled}>
          Drop account
        </Button>
      </div>
    );
  }
  return (
    <div class="services-creds-drop-row services-creds-drop-row-confirming">
      <span class="services-creds-drop-warning">
        Drop <code>{accountName}</code> on this network? This is irreversible.
      </span>
      <Button type="button" variant="secondary" onClick={onConfirm} disabled={disabled || pending}>
        {pending ? 'Dropping…' : 'Yes, drop it'}
      </Button>
      <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
        Cancel
      </Button>
    </div>
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

const OPER_INDEX: Array<[string, string]> = [
  ['OPER', 'Authenticate as a server operator using an existing IRCd oper block (name + password). On success the server replies 381 and the Operator badge lights.'],
];

function ServerInfoSubSection({ onRunCommand, serverLog, search }: SubSectionCommonProps) {
  return (
    <>
    <MaybeCard visible={anyMatch(search, OPER_INDEX)}>
      <div class="server-settings-card-body">
        <h3 class="server-settings-subhead">Operator</h3>
        <p class="server-settings-subhint">
          Already have operator credentials on this network? Authenticate against
          the server's oper block. The password is sent to the daemon and never
          stored by Boson.
        </p>
        <Divider />
        <CapturingTwoArgCommand
          label="OPER" hint={OPER_INDEX[0]![1]}
          placeholders={['oper name', 'password']}
          inputTypes={['text', 'password']}
          buttonLabel="Authenticate"
          buildCommand={(name, password) => `/oper ${name} ${password}`}
          onRunCommand={onRunCommand} serverLog={serverLog} search={search}
        />
      </div>
    </MaybeCard>
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
    </>
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
