import { useEffect, useMemo, useState } from 'preact/hooks';
import { AtomLoader, Badge, Button, Card, ChipInput, Field, Input, Modal, Toggle, useTransientFlag } from '@boson/shared';
import type {
  DirectoryService,
  ServerWithToken,
  VerifyOutcome,
  VerifyReport,
} from '../../modules/directory';
import { ServerHostingBloc, type ServerHostingState } from './ServerHostingBloc';

interface HostServerModalProps {
  open: boolean;
  onClose: () => void;
  directory: DirectoryService;
}

// Opens the "register a server in the directory" flow as a modal on top
// of the Directory screen. Three internal views (list of the user's
// existing rows / register form / verify with TXT snippet) drive off
// the same ServerHostingBloc — the modal is just the chrome around
// them. The bloc is recreated on every open so closing mid-form
// doesn't leak draft state into the next session.
export function HostServerModal({ open, onClose, directory }: HostServerModalProps) {
  // Keying the bloc on `open` resets it each time the modal reopens.
  // useMemo with no deps would keep stale form state across opens.
  const bloc = useMemo(() => new ServerHostingBloc(directory), [directory, open]);
  const [state, setState] = useState<ServerHostingState>(() => bloc.getState());
  useEffect(() => bloc.subscribe(setState), [bloc]);
  useEffect(() => { if (open) void bloc.load(); }, [bloc, open]);

  return (
    <Modal open={open} onClose={onClose} title="Add your server to the directory">
      <div class="host-server-modal-body">
        <p class="host-server-modal-intro">
          Register your IRC server so users can discover it from the directory.
          We verify ownership via a DNS TXT record before listing publicly —
          no waiting on a human reviewer.
        </p>
        {state.screen === 'list' && <ListView state={state} bloc={bloc} />}
        {state.screen === 'register' && <RegisterView state={state} bloc={bloc} />}
        {state.screen === 'verify' && <VerifyView state={state} bloc={bloc} />}
      </div>
    </Modal>
  );
}

// ---------- List view ----------

function ListView({ state, bloc }: { state: ServerHostingState; bloc: ServerHostingBloc }) {
  return (
    <>
      <div class="server-hosting-list-actions">
        <Button variant="primary" onClick={() => bloc.openRegister()}>Add a server</Button>
      </div>
      {state.loadingList ? (
        <div class="server-hosting-empty">
          <AtomLoader size={28} />
          <span>Loading your servers…</span>
        </div>
      ) : state.listError ? (
        <Card>
          <div class="user-settings-card-body">
            <p class="server-hosting-error">Couldn't load: {state.listError}</p>
            <Button variant="ghost" onClick={() => { void bloc.load(); }}>Retry</Button>
          </div>
        </Card>
      ) : state.myServers.length === 0 ? (
        <Card>
          <div class="user-settings-card-body server-hosting-empty">
            <p>No servers registered yet.</p>
            <p class="server-hosting-empty-hint">
              Click <strong>Add a server</strong> to register one. You'll need
              control of a DNS record on the hostname you submit.
            </p>
          </div>
        </Card>
      ) : (
        <div class="server-hosting-rows">
          {state.myServers.map((s) => (
            <ServerRow key={s.id} server={s} onContinue={() => bloc.openVerify(s)} />
          ))}
        </div>
      )}
    </>
  );
}

function ServerRow({ server, onContinue }: { server: ServerWithToken; onContinue: () => void }) {
  return (
    <Card>
      <div class="server-hosting-row">
        <div class="server-hosting-row-titles">
          <h3 class="server-hosting-row-name">{server.name}</h3>
          <span class="server-hosting-row-host">
            {server.hostname}:{server.port}{server.tls ? ' (TLS)' : ''}
          </span>
        </div>
        <div class="server-hosting-row-status">
          <StatusBadge status={server.verification_status} />
          {server.verification_status === 'pending' && (
            <Button variant="primary" onClick={onContinue}>Continue verification</Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function StatusBadge({ status }: { status: ServerWithToken['verification_status'] }) {
  switch (status) {
    case 'verified': return <Badge tone="success">Verified</Badge>;
    case 'lapsed':   return <Badge tone="warn">Lapsed</Badge>;
    default:         return <Badge tone="info">Pending</Badge>;
  }
}

// ---------- Register view ----------

function RegisterView({ state, bloc }: { state: ServerHostingState; bloc: ServerHostingBloc }) {
  const { registerDraft: d, registerSubmitting, registerError } = state;
  const submit = (e: Event): void => {
    e.preventDefault();
    void bloc.submitRegister();
  };
  return (
    <Card>
      <form class="user-settings-form server-hosting-form" onSubmit={submit}>
        <div class="server-hosting-form-row">
          <Field label="Display name" hint="What users will see in the directory.">
            <Input
              value={d.name}
              onInput={(e) => bloc.updateDraft({ name: (e.target as HTMLInputElement).value })}
              required
              autoFocus
              autoComplete="off"
              spellcheck={false}
            />
          </Field>
          <Field label="Hostname" hint="DNS-resolvable name. IP-only servers are rejected.">
            <Input
              value={d.hostname}
              onInput={(e) => bloc.updateDraft({ hostname: (e.target as HTMLInputElement).value })}
              required
              autoComplete="off"
              spellcheck={false}
              placeholder="irc.example.org"
            />
          </Field>
        </div>
        <div class="server-hosting-form-row">
          <Field label="Port" hint="6697 is the TLS default.">
            <Input
              value={d.port}
              onInput={(e) => bloc.updateDraft({ port: (e.target as HTMLInputElement).value })}
              required
              autoComplete="off"
              spellcheck={false}
            />
          </Field>
          <div class="server-hosting-form-toggle">
            <Toggle
              checked={d.tls}
              onChange={(tls) => bloc.updateDraft({ tls })}
              label="TLS (recommended)"
            />
          </div>
        </div>

        <Field label="Description" hint="One paragraph. What's the community for? Who's it not for?">
          <textarea
            class="server-hosting-textarea"
            value={d.description}
            onInput={(e) => bloc.updateDraft({ description: (e.target as HTMLTextAreaElement).value })}
            rows={3}
            spellcheck
          />
        </Field>

        <div class="server-hosting-form-row">
          <Field label="Tags" hint="Press Enter or comma to add. Click × to remove.">
            <ChipInput
              value={d.tags}
              onChange={(tags) => bloc.updateDraft({ tags })}
              ariaLabel="Tags"
              placeholder="foss, community"
              stripHash
            />
          </Field>
          <Field label="Languages" hint="ISO codes (e.g. en, fr, ja). Required: at least one.">
            <ChipInput
              value={d.languages}
              onChange={(languages) => bloc.updateDraft({ languages })}
              ariaLabel="Languages"
              placeholder="en, fr"
              pattern={/^[a-z]{2}(-[a-z0-9]{2,4})?$/}
            />
          </Field>
        </div>

        <div class="server-hosting-form-toggle">
          <Toggle
            checked={d.isNsfw}
            onChange={(isNsfw) => bloc.updateDraft({ isNsfw })}
            label="NSFW — hidden from default search"
          />
        </div>

        {registerError && <p class="server-hosting-error">{registerError}</p>}

        <div class="user-settings-form-actions">
          <Button type="button" variant="ghost" onClick={() => bloc.closeRegister()}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={registerSubmitting}>
            {registerSubmitting ? 'Submitting…' : 'Register'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---------- Verify view ----------

function VerifyView({ state, bloc }: { state: ServerHostingState; bloc: ServerHostingBloc }) {
  const active = state.active;
  if (!active) return null;
  const txtRecord = `_boson.${active.hostname}.  300  IN  TXT  "boson-verify=${active.verification_token ?? ''}"`;
  const txtBody = `boson-verify=${active.verification_token ?? ''}`;
  return (
    <>
      <Card>
        <div class="user-settings-card-body">
          <div class="server-hosting-verify-head">
            <div>
              <h3 class="server-hosting-row-name">{active.name}</h3>
              <span class="server-hosting-row-host">
                {active.hostname}:{active.port}{active.tls ? ' (TLS)' : ''}
              </span>
            </div>
            <StatusBadge status={active.verification_status} />
          </div>

          <ol class="server-hosting-steps">
            <li>
              <strong>Add this TXT record</strong> to the DNS zone for{' '}
              <code class="server-hosting-mono">{active.hostname}</code>. Most
              providers (Cloudflare, Route53, DO) accept the value verbatim.
              <Terminal>
                <code class="server-hosting-record">{txtRecord}</code>
              </Terminal>
              <div class="server-hosting-copy-row">
                <CopyButton label="Copy record" value={txtRecord} />
                <CopyButton label="Copy token only" value={txtBody} />
              </div>
            </li>
            <li>
              <strong>Wait for propagation</strong> (usually under a minute,
              up to 72h for slow providers). You can sanity-check from a
              terminal:
              <Terminal>
                <code>dig +short TXT _boson.{active.hostname} @1.1.1.1</code>
              </Terminal>
            </li>
            <li>
              <strong>Verify.</strong> We query Cloudflare, Google, and Quad9
              in parallel. Initial verification requires all three to see
              the same record — this is the strictest check, and the cron
              re-verifier later is more forgiving.
              <VerifyAction state={state} bloc={bloc} />
            </li>
          </ol>
        </div>
      </Card>
      <div class="user-settings-form-actions">
        <Button variant="ghost" onClick={() => bloc.backToList()}>Back to list</Button>
      </div>
    </>
  );
}

function VerifyAction({ state, bloc }: { state: ServerHostingState; bloc: ServerHostingBloc }) {
  const verify = state.verify;

  // 30-second cooldown ticking down while we're rate-limited; lets us
  // visually disable the button without polling the backend.
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (verify.kind !== 'rate-limited') return;
    setCooldown(verify.retryAfterSec);
    const id = window.setInterval(() => {
      setCooldown((n) => (n <= 1 ? 0 : n - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [verify]);

  const inFlight = verify.kind === 'in-flight';
  const blocked = verify.kind === 'rate-limited' && cooldown > 0;

  return (
    <div class="server-hosting-verify-action">
      <div class="server-hosting-verify-buttons">
        <Button
          variant="primary"
          disabled={inFlight || blocked}
          onClick={() => { void bloc.runVerify(); }}
        >
          {inFlight ? 'Verifying…' : blocked ? `Retry in ${cooldown}s` : 'Verify now'}
        </Button>
        {verify.kind === 'token-expired' && (
          <Button variant="ghost" onClick={() => { void bloc.runRegenerateToken(); }}>
            Regenerate token
          </Button>
        )}
      </div>
      <VerifyOutcomeBanner verify={verify} />
    </div>
  );
}

function VerifyOutcomeBanner({ verify }: { verify: ServerHostingState['verify'] }) {
  switch (verify.kind) {
    case 'idle':
    case 'in-flight':
      return null;
    case 'success':
      return (
        <div class="server-hosting-banner server-hosting-banner-success">
          Verified. Your server is live on the directory.
        </div>
      );
    case 'token-expired':
      return (
        <div class="server-hosting-banner server-hosting-banner-warn">
          This token expired (72h limit). Regenerate to get a fresh one,
          replace the TXT record value, and try again.
        </div>
      );
    case 'rate-limited':
      return (
        <div class="server-hosting-banner server-hosting-banner-warn">
          Slow down — at most one verify every 30 seconds.
        </div>
      );
    case 'partial':
      return <ResolverMatrix report={verify.report} />;
    case 'error':
      return (
        <div class="server-hosting-banner server-hosting-banner-error">
          Verify failed: {verify.message}
        </div>
      );
  }
}

function ResolverMatrix({ report }: { report: VerifyReport }) {
  const entries = Object.entries(report.results);
  return (
    <div class="server-hosting-banner server-hosting-banner-warn">
      <p style="margin: 0 0 8px;">
        DNS not fully propagated. Wait a minute and try again.
      </p>
      <table class="server-hosting-matrix">
        <tbody>
          {entries.map(([provider, result]) => (
            <tr key={provider}>
              <td class="server-hosting-matrix-provider">{prettyProvider(provider)}</td>
              <td class={`server-hosting-matrix-outcome server-hosting-matrix-outcome-${result.outcome}`}>
                {outcomeIcon(result.outcome)} {prettyOutcome(result.outcome)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function prettyProvider(p: string): string {
  switch (p) {
    case 'cloudflare': return 'Cloudflare (1.1.1.1)';
    case 'google':     return 'Google (8.8.8.8)';
    case 'quad9':      return 'Quad9 (9.9.9.9)';
    default:           return p;
  }
}

function prettyOutcome(o: VerifyOutcome): string {
  switch (o) {
    case 'match':          return 'Matched';
    case 'missing_record': return 'Record missing';
    case 'timeout':        return 'Timed out';
    case 'error':          return 'Error';
  }
}

function outcomeIcon(o: VerifyOutcome): string {
  return o === 'match' ? '✓' : '✗';
}

// ---------- Tiny inline primitives ----------

function Terminal({ children }: { children: preact.ComponentChildren }) {
  return <pre class="server-hosting-terminal">{children}</pre>;
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, triggerCopied] = useTransientFlag(1400);
  const handle = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      triggerCopied();
    } catch {
      // Some Electron contexts disable clipboard writes — fall back
      // silently. The TXT record is visible in the <pre> so the user
      // can still select + copy manually.
    }
  };
  return (
    <Button type="button" variant="ghost" onClick={handle}>
      {copied ? 'Copied' : label}
    </Button>
  );
}
