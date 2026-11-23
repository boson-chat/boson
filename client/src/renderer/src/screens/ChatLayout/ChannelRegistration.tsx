// The Registration tab of Channel settings: what ChanServ says about the
// channel (registered, founder, expiry), registering it, and — for its
// founder and ops — persistent roles, ChanServ options and ownership.
// Everything goes through the per-connection ChanServController, which maps
// each action onto the network's services package (Ergo, Anope, Atheme, …).
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { RefreshCw, ShieldCheck, ShieldOff, ShieldAlert } from 'lucide-preact';
import { Button, Input, ListRow, Select, SwitchRow } from '@boson/shared';
import {
  CHAN_ROLES, chanServErrorText, sameName,
  type AccessEntry, type ChanRole, type ChanServController, type ChanServResult, type ChanServState, type ChannelPolicy,
  type ChannelRegistration as Registration,
} from '../../modules/chanserv';
import { OP } from '../../modules/chat/channel-ops';
import './ChannelRegistration.css';

export const ROLE_LABEL: Record<ChanRole, string> = {
  founder: 'Founder (~)',
  admin: 'Admin (&)',
  op: 'Op (@)',
  halfop: 'Half-op (%)',
  voice: 'Voice (+)',
};

interface Props {
  channel: string;
  ctl: ChanServController;
  state: ChanServState;
  myRank: number;
  myAccount?: string;
  policy: ChannelPolicy | null;
  // The channel-mode toggles that belong with the channel's protection
  // (+R / +M, and +t on Ergo where it is the topic lock), rendered by
  // Channel settings so they share its optimistic mode state.
  lockToggles?: ComponentChildren;
}

export function ChannelRegistration({ channel, ctl, state, myRank, myAccount, policy, lockToggles }: Props) {
  const cs = ctl.channel(channel);
  const info = cs.info;
  const caps = state.caps;

  useEffect(() => { ctl.ensureInfo(channel); }, [ctl, channel]);

  const isFounder = !!info?.registered && sameName(info.founder, myAccount);
  const manages = !!info?.registered && !info.closed && (isFounder || myRank >= OP);
  const offered = state.offers.some((o) => sameName(o, channel));

  return (
    <div class="chan-reg">
      <StatusBlock
        channel={channel}
        info={info}
        loading={cs.infoStatus === 'loading' && !info}
        error={cs.infoStatus === 'error' ? cs.infoError : undefined}
        policy={policy}
        isFounder={isFounder}
        onRefresh={() => { void ctl.refresh(channel); }}
      />

      {offered && <OfferBanner channel={channel} ctl={ctl} />}

      {info && !info.registered && !info.closed && caps?.register && !policy?.autoRegister && (
        <RegisterAction channel={channel} ctl={ctl} myAccount={myAccount} myRank={myRank} withDescription={caps.registerDescription} />
      )}

      {manages && caps && (
        <>
          {caps.access && <RolesSection channel={channel} ctl={ctl} founder={info!.founder} roles={caps.roles} access={cs.access} status={cs.accessStatus} error={cs.accessError?.code} />}
          {(caps.options.length > 0 || lockToggles) && (
            <section class="chan-settings-section">
              <h4 class="chan-settings-heading">Protection</h4>
              {lockToggles}
              {caps.options.map((o) => (
                <OptionRow key={o.id} channel={channel} ctl={ctl} option={o} info={info!} />
              ))}
            </section>
          )}
          {isFounder && (caps.transfer || caps.unregister) && (
            <OwnershipSection channel={channel} ctl={ctl} transfer={caps.transfer} unregister={caps.unregister} myAccount={myAccount} />
          )}
        </>
      )}

      {state.label && <p class="chan-reg-source">Channel services: {state.label}</p>}
    </div>
  );
}

// ---- status -----------------------------------------------------------------

function StatusBlock({ channel, info, loading, error, policy, isFounder, onRefresh }: {
  channel: string;
  info?: Registration;
  loading: boolean;
  error?: { code: Parameters<typeof chanServErrorText>[0]; lines: string[] };
  policy: ChannelPolicy | null;
  isFounder: boolean;
  onRefresh: () => void;
}) {
  let icon = <ShieldOff size={20} aria-hidden="true" />;
  let tone = 'muted';
  let title = 'Not registered';
  let lines: ComponentChildren[] = [];
  if (loading) {
    title = 'Checking with ChanServ…';
    tone = 'pending';
  } else if (error && !info) {
    icon = <ShieldAlert size={20} aria-hidden="true" />;
    tone = 'warn';
    title = chanServErrorText(error.code);
  } else if (info?.closed) {
    icon = <ShieldAlert size={20} aria-hidden="true" />;
    tone = 'warn';
    title = 'Closed by network staff';
    lines = ['Nobody can use or register this channel.'];
  } else if (info?.registered) {
    icon = <ShieldCheck size={20} aria-hidden="true" />;
    tone = 'ok';
    title = 'Registered';
    if (info.founder) lines.push(<>Founder <strong>{info.founder}</strong>{isFounder ? ' (you)' : ''}</>);
    if (info.registeredAt) lines.push(`Registered ${info.registeredAt}`);
    if (info.lastUsed) lines.push(`Last active ${info.lastUsed}`);
    if (policy && policy.expiryDays > 0) {
      lines.push(`Expires after ${policy.expiryDays} ${policy.expiryDays === 1 ? 'day' : 'days'} of inactivity`);
    } else if (info.expires) {
      lines.push(`Expires ${info.expires}`);
    }
  } else if (info) {
    lines = [policy?.autoRegister
      ? 'Channels on this server are registered to the signed-in person who creates them.'
      : `Registering ${channel} keeps its modes, topic and roles when everyone leaves, and makes you its founder.`];
  }
  return (
    <section class={`chan-reg-status chan-reg-status-${tone}`} aria-live="polite">
      <span class="chan-reg-status-icon">{icon}</span>
      <div class="chan-reg-status-text">
        <p class="chan-reg-status-title">{title}</p>
        {lines.map((l, i) => <p key={i} class="chan-reg-status-line">{l}</p>)}
        {error && !info && error.code === 'unreadable' && <ReplyDetails lines={error.lines} />}
      </div>
      <Button
        variant="ghost"
        size="sm"
        class="chan-reg-refresh"
        icon={<RefreshCw size={14} />}
        onClick={onRefresh}
        title="Check again"
        aria-label="Check registration again"
      />
    </section>
  );
}

function ReplyDetails({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return (
    <details class="chan-reg-details">
      <summary>ChanServ's reply</summary>
      <pre>{lines.map(stripFormatting).join('\n')}</pre>
    </details>
  );
}

const stripFormatting = (s: string): string => s.replace(/\x03(?:\d{1,2}(?:,\d{1,2})?)?|[\x02\x0f\x11\x16\x1d\x1e\x1f]/g, '');

// Feedback line under an action: plain-language error, or what happened.
function Outcome({ result, success }: { result: ChanServResult | null; success?: string }) {
  if (!result) return null;
  if (result.kind === 'done') return success ? <p class="chan-reg-ok" role="status">{success}</p> : null;
  return (
    <div class="chan-reg-error" role="alert">
      <p>{chanServErrorText(result.code)}</p>
      {(result.code === 'unreadable' || result.code === 'failed') && <ReplyDetails lines={result.lines} />}
    </div>
  );
}

// Run an action with a busy flag and keep its result for <Outcome>.
function useAction(): [boolean, ChanServResult | null, (fn: () => Promise<ChanServResult>) => Promise<ChanServResult>, () => void] {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ChanServResult | null>(null);
  const run = async (fn: () => Promise<ChanServResult>): Promise<ChanServResult> => {
    setBusy(true);
    setResult(null);
    try {
      const r = await fn();
      setResult(r);
      return r;
    } finally {
      setBusy(false);
    }
  };
  return [busy, result, run, () => setResult(null)];
}

// ---- register -----------------------------------------------------------------

function RegisterAction({ channel, ctl, myAccount, myRank, withDescription }: {
  channel: string; ctl: ChanServController; myAccount?: string; myRank: number; withDescription: boolean;
}) {
  const [busy, result, run] = useAction();
  const [desc, setDesc] = useState('');
  // Only being an op is a hard requirement we can check here. Whether
  // you're identified is ChanServ's call: plenty of networks never tell the
  // client (no RPL_LOGGEDIN after a NickServ IDENTIFY), so an unknown account
  // only earns a hint, and ChanServ's own answer shows if it refuses.
  const why = myRank < OP ? 'Only channel operators (@) can register it.' : null;
  const hint = !why && !myAccount ? 'You need to be identified to NickServ; ChanServ will say if you aren\u2019t.' : null;
  return (
    <section class="chan-settings-section chan-reg-register">
      {withDescription && !why && (
        <Input
          inputSize="sm" type="text" value={desc} placeholder="Description (optional)" aria-label="Channel description"
          maxLength={200}
          onInput={(e) => setDesc((e.target as HTMLInputElement).value)}
        />
      )}
      <div class="chan-reg-row">
        <Button size="sm" loading={busy} disabled={!!why} onClick={() => run(() => ctl.register(channel, desc))}>
          Register {channel}
        </Button>
        {(why ?? hint) && <span class="chan-settings-note">{why ?? hint}</span>}
      </div>
      <Outcome result={result} success={`Registered. You're the founder of ${channel}.`} />
    </section>
  );
}

function OfferBanner({ channel, ctl }: { channel: string; ctl: ChanServController }) {
  const [busy, result, run] = useAction();
  return (
    <section class="chan-reg-offer" role="status">
      <p>You've been offered ownership of {channel}.</p>
      <div class="chan-reg-row">
        <Button size="sm" loading={busy} onClick={() => run(() => ctl.acceptTransfer(channel))}>Accept ownership</Button>
        <Button size="sm" variant="ghost" onClick={() => ctl.dismissOffer(channel)}>Not now</Button>
      </div>
      <Outcome result={result} />
    </section>
  );
}

// ---- roles ----------------------------------------------------------------------

function RolesSection({ channel, ctl, founder, roles, access, status, error }: {
  channel: string; ctl: ChanServController; founder?: string; roles: readonly ChanRole[];
  access?: AccessEntry[]; status: string; error?: Parameters<typeof chanServErrorText>[0];
}) {
  useEffect(() => { void ctl.loadAccess(channel); }, [ctl, channel]);
  const [account, setAccount] = useState('');
  const [role, setRole] = useState<ChanRole>(roles.includes('op') ? 'op' : roles[0]!);
  const [busy, result, run] = useAction();

  const entries = (access ?? []).filter((e) => !(e.role === 'founder' && sameName(e.account, founder) && e.raw !== 'QOP'));
  const add = async (): Promise<void> => {
    const name = account.trim();
    if (!name) return;
    const prev = access?.find((e) => sameName(e.account, name))?.role ?? null;
    const r = await run(() => ctl.setAccess(channel, name, role, prev));
    if (r.kind === 'done') setAccount('');
  };

  return (
    <section class="chan-settings-section">
      <h4 class="chan-settings-heading">Roles</h4>
      <p class="chan-settings-note">Given automatically whenever these accounts join.</p>
      {founder && (
        <ListRow class="chan-role-row chan-role-founder" title={founder} trailing={<span class="chan-role-fixed">Founder</span>} />
      )}
      {status === 'loading' && !access && <p class="chan-settings-note">Loading roles…</p>}
      {status === 'error' && error && <p class="chan-reg-error">{chanServErrorText(error)}</p>}
      {entries.length > 0 && (
        <ul class="chan-roles" aria-label="Accounts with roles">
          {entries.map((e) => (
            <RoleRow key={e.account} channel={channel} ctl={ctl} entry={e} roles={roles} />
          ))}
        </ul>
      )}
      {status === 'ready' && entries.length === 0 && <p class="chan-settings-note">Nobody else has a role yet.</p>}
      <div class="chan-param-row">
        <Input
          inputSize="sm" type="text" value={account} placeholder="Account name" aria-label="Account name"
          onInput={(e) => setAccount((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
        />
        <Select size="sm" class="chan-role-select" label="Role" value={role} onChange={setRole}
          options={roles.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
        <Button variant="secondary" size="sm" loading={busy} disabled={!account.trim()} onClick={() => void add()}>Add</Button>
      </div>
      <Outcome result={result} />
    </section>
  );
}

function RoleRow({ channel, ctl, entry, roles }: { channel: string; ctl: ChanServController; entry: AccessEntry; roles: readonly ChanRole[] }) {
  const [busy, result, run] = useAction();
  return (
    <ListRow
      as="li"
      class="chan-role-row"
      title={entry.account}
      trailing={<>
        {entry.role ? (
          <Select
            size="sm" class="chan-role-select" label={`Role for ${entry.account}`} value={entry.role} disabled={busy}
            options={CHAN_ROLES.filter((r) => roles.includes(r)).map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
            onChange={(next) => void run(() => ctl.setAccess(channel, entry.account, next, entry.role))}
          />
        ) : (
          <span class="chan-role-fixed" title="A custom access level, managed with ChanServ directly">{entry.raw}</span>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(() => ctl.setAccess(channel, entry.account, null, entry.role))}>
          Remove
        </Button>
      </>}
    >
      {result?.kind === 'error' && <span class="chan-role-error">{chanServErrorText(result.code)}</span>}
    </ListRow>
  );
}

// ---- options --------------------------------------------------------------------

function OptionRow({ channel, ctl, option, info }: {
  channel: string; ctl: ChanServController; option: { id: string; label: string; hint: string; choices?: ReadonlyArray<{ value: string; label: string }> };
  info: Registration;
}) {
  const [busy, result, run] = useAction();
  if (option.choices) {
    const value = info.values?.[option.id];
    return (
      <div class="chan-mode-row chan-option-choice">
        <label class="chan-param-label" id={`cs-opt-${option.id}-label`} for={`cs-opt-${option.id}`}>{option.label}</label>
        <Select
          id={`cs-opt-${option.id}`} labelledBy={`cs-opt-${option.id}-label`} size="sm" class="chan-role-select" value={value ?? ''} disabled={busy}
          options={[...(value === undefined ? [{ value: '', label: 'Unknown', disabled: true }] : []), ...option.choices]}
          onChange={(v) => void run(() => ctl.setOption(channel, option.id, v))}
        />
        <span class="chan-mode-hint">{option.hint}</span>
        {result?.kind === 'error' && <span class="chan-role-error">{chanServErrorText(result.code)}</span>}
      </div>
    );
  }
  // INFO didn't show the options (no access to see them): don't guess.
  const known = info.options !== undefined;
  return (
    <div class="chan-mode-row">
      <SwitchRow
        title={option.label}
        description={option.hint}
        checked={!!info.options?.[option.id]}
        disabled={busy || !known}
        onChange={(next) => void run(() => ctl.setOption(channel, option.id, next))}
      />
      {result?.kind === 'error' && <span class="chan-role-error">{chanServErrorText(result.code)}</span>}
    </div>
  );
}

// ---- ownership ----------------------------------------------------------------

function OwnershipSection({ channel, ctl, transfer, unregister, myAccount }: {
  channel: string; ctl: ChanServController; transfer: 'code-accept' | 'direct' | 'flags' | null; unregister: boolean; myAccount?: string;
}) {
  const [to, setTo] = useState('');
  const [confirmTransfer, setConfirmTransfer] = useState(false);
  const [tBusy, tResult, runTransfer, clearTransfer] = useAction();
  const [typed, setTyped] = useState('');
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [dBusy, dResult, runDrop] = useAction();

  const target = to.trim();
  const transferNote = transfer === 'code-accept'
    ? `${target || 'They'} must accept before it moves to them.`
    : transfer === 'flags'
      ? 'They become a founder and you stop being one. You keep your other access until they change it.'
      : 'This takes effect at once.';
  const transferDone = tResult?.kind === 'done'
    ? (tResult.pending ? `Offered to ${target || 'them'}. It moves once they accept.` : `${channel} now belongs to ${target || 'them'}.`)
    : undefined;

  return (
    <section class="chan-settings-section chan-reg-ownership">
      <h4 class="chan-settings-heading">Ownership</h4>
      {transfer && (
        <div class="chan-reg-block">
          <label class="chan-reg-label" for="cs-transfer">Transfer ownership</label>
          <div class="chan-param-row">
            <Input
              inputSize="sm" id="cs-transfer" type="text" value={to} placeholder="Account name"
              onInput={(e) => { setTo((e.target as HTMLInputElement).value); setConfirmTransfer(false); clearTransfer(); }}
            />
            <Button variant="secondary" size="sm" disabled={!target || sameName(target, myAccount) || confirmTransfer} onClick={() => setConfirmTransfer(true)}>
              Transfer…
            </Button>
          </div>
          {confirmTransfer && (
            <div class="chan-reg-confirm">
              <p>Make <strong>{target}</strong> the founder of {channel}? {transferNote}</p>
              <div class="chan-reg-row">
                <Button size="sm" loading={tBusy} onClick={async () => {
                  const r = await runTransfer(() => ctl.transfer(channel, target));
                  if (r.kind === 'done') setConfirmTransfer(false);
                }}>Transfer to {target}</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmTransfer(false)}>Cancel</Button>
              </div>
            </div>
          )}
          <Outcome result={tResult} success={transferDone} />
        </div>
      )}
      {unregister && (
        <div class="chan-reg-block chan-reg-danger">
          <p class="chan-reg-label">Unregister</p>
          <p class="chan-settings-note">ChanServ forgets {channel}: its founder, roles and saved settings. Anyone can register it after.</p>
          {!confirmDrop ? (
            <div class="chan-reg-row">
              <Button variant="secondary" size="sm" onClick={() => setConfirmDrop(true)}>Unregister {channel}…</Button>
            </div>
          ) : (
            <div class="chan-reg-confirm">
              <label class="chan-settings-note" for="cs-drop">Type <strong>{channel}</strong> to confirm.</label>
              <div class="chan-param-row">
                <Input inputSize="sm" id="cs-drop" type="text" value={typed} autoComplete="off" onInput={(e) => setTyped((e.target as HTMLInputElement).value)} />
                <Button variant="danger" size="sm" loading={dBusy} disabled={!sameName(typed.trim(), channel)} onClick={() => runDrop(() => ctl.unregister(channel))}>
                  Unregister
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setConfirmDrop(false); setTyped(''); }}>Cancel</Button>
              </div>
            </div>
          )}
          <Outcome result={dResult} success={`${channel} is no longer registered.`} />
        </div>
      )}
    </section>
  );
}
