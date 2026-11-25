import { useEffect, useState } from 'preact/hooks';
import { Badge, Button, EmptyState, ListRow } from '@boson/shared';
import { describeAuthError, type LinkedIdentities } from '../../modules/auth';
import {
  getNetworkAccounts, hostOf, type KnownAuth, type NetworkAccounts, type NetworkAccountsSnapshot,
} from '../../modules/netauth/network-accounts';
import { SectionFrame, SettingsGroup } from './SettingsFrame';

// Settings → Network accounts: accounts on self-hosted boson networks, one
// per network sign-in service, beside the boson.chat account. Each can be
// signed in or out on its own; the boson.chat-only features say so.
export function NetworkAccountsSection({ open, accounts = getNetworkAccounts() }: { open: boolean; accounts?: NetworkAccounts | null }) {
  const [snap, setSnap] = useState<NetworkAccountsSnapshot | null>(() => accounts?.getSnapshot() ?? null);
  useEffect(() => (accounts ? accounts.subscribe(setSnap) : undefined), [accounts]);

  return (
    <SectionFrame
      title="Network accounts"
      description="Networks that run their own boson server have their own accounts: signed in, Boson logs you in to that network's IRC and voice with it. Your boson.chat account stays the main one for your profile, encryption key, synced settings and nick claims."
    >
      {!accounts || !snap ? (
        <EmptyState>Network accounts need the desktop app.</EmptyState>
      ) : snap.known.length === 0 ? (
        <EmptyState>
          No network accounts yet. Join a network that runs its own boson server and it offers its own sign-in.
        </EmptyState>
      ) : (
        <SettingsGroup title="Your network accounts">
          <ul class="settings-rows" aria-label="Network accounts">
            {snap.known.map((k) => (
              <AccountRow key={k.authUrl} accounts={accounts} known={k} snap={snap} open={open} />
            ))}
          </ul>
        </SettingsGroup>
      )}
    </SectionFrame>
  );
}

function AccountRow({ accounts, known, snap, open }: {
  accounts: NetworkAccounts;
  known: KnownAuth;
  snap: NetworkAccountsSnapshot;
  open: boolean;
}) {
  const session = snap.sessions[known.authUrl] ?? null;
  const name = accounts.nameFor(known.authUrl);
  const host = known.hosts[0] ?? hostOf(known.authUrl);
  const [busy, setBusy] = useState(false);
  const [manage, setManage] = useState(false);
  return (
    <ListRow
      as="li"
      title={name}
      meta={session && <Badge tone="success">Signed in</Badge>}
      subtitle={session ? `${session.user.username}${session.user.email ? ` · ${session.user.email}` : ''}` : hostOf(known.authUrl)}
      trailing={session ? (
        <>
          <Button variant="ghost" size="sm" onClick={() => setManage((m) => !m)} aria-expanded={manage}>
            {manage ? 'Done' : 'Sign-ins'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={busy}
            disabled={busy}
            onClick={() => { setBusy(true); void accounts.signOut(known.authUrl).finally(() => setBusy(false)); }}
          >
            Sign out
          </Button>
        </>
      ) : (
        <>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void (async () => {
                const link = await accounts.discover(host);
                if (link) await accounts.promptSignIn({ link, serverName: name, reason: 'manage', allowGuest: false });
              })();
            }}
          >
            Sign in
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { void accounts.forget(known.authUrl); }} aria-label={`Remove ${name}`}>
            Remove
          </Button>
        </>
      )}
    >
      <span class="settings-row-note">IRC: {known.hosts.join(', ')}</span>
      {session && manage && <NetworkSignIns accounts={accounts} authUrl={known.authUrl} open={open} />}
    </ListRow>
  );
}

// The account's linked "Sign in with …" identities on that network, with
// Unlink (refused for the last way in).
function NetworkSignIns({ accounts, authUrl, open }: { accounts: NetworkAccounts; authUrl: string; open: boolean }) {
  const [data, setData] = useState<LinkedIdentities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const auth = accounts.service(authUrl);
  useEffect(() => {
    if (!open) return;
    let live = true;
    auth.identities().then((d) => { if (live) setData(d); }, (err) => { if (live) setError(describeAuthError(err)); });
    return () => { live = false; };
  }, [auth, open]);
  if (error && !data) return <p class="user-settings-error settings-row-detail" role="alert">{error}</p>;
  if (!data) return <p class="user-settings-hint settings-row-detail">Loading…</p>;
  const only = !data.has_password && data.identities.length === 1;
  return (
    <div class="user-settings-identities settings-row-detail">
      <span class="user-settings-identities-desc">
        {data.identities.length === 0
          ? 'Password only: no other sign-ins are linked.'
          : data.has_password ? 'You can also sign in with your password.' : 'No password: these are the ways in.'}
      </span>
      {data.identities.length > 0 && (
        <ul class="user-settings-identities-list">
          {data.identities.map((i) => (
            <ListRow
              key={i.id}
              as="li"
              title={i.provider_display_name || i.provider_slug}
              subtitle={i.email ?? i.subject}
              trailing={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null || only}
                  loading={busy === i.id}
                  title={only ? "It's the only way to sign in to this account" : undefined}
                  onClick={() => {
                    setBusy(i.id);
                    setError(null);
                    void auth.unlinkIdentity(i.id)
                      .then(() => auth.identities().then(setData))
                      .catch((err) => setError(describeAuthError(err)))
                      .finally(() => setBusy(null));
                  }}
                >
                  Unlink
                </Button>
              }
            />
          ))}
        </ul>
      )}
      {error && <p class="user-settings-error" role="alert">{error}</p>}
    </div>
  );
}
