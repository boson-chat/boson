import { useEffect, useState } from 'preact/hooks';
import { Button, Field, Input, SwitchRow, useTransientFlag } from '@boson/shared';
import { getBouncerStore, type BouncerProfile } from '../../modules/chat/bouncer.store';
import { NestedSettings, SectionFrame } from './SettingsFrame';

// Settings → Bouncer: the global bouncer (ZNC/BNC) profile. One per user;
// E2E-encrypted + synced via BouncerSyncService when signed in. The store
// persists locally regardless, so editing works in guest mode too (it just
// won't sync until signed in). It's one profile, so the form saves as one
// (with Save), switches included.
const EMPTY_BOUNCER: BouncerProfile = {
  enabled: false, host: '', port: 6697, tls: true,
  tlsInsecure: false, username: '', password: '',
};

export function BouncerSection({ mode, open }: {
  mode: 'guest' | 'account';
  open: boolean;
}) {
  const [draft, setDraft] = useState<BouncerProfile>(EMPTY_BOUNCER);
  const [saved, triggerSaved] = useTransientFlag();

  // Load the stored profile when the section mounts / the modal re-opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const store = getBouncerStore();
    void store.whenHydrated().then(() => {
      if (cancelled) return;
      // Only load when something is actually stored — otherwise we'd clobber
      // an in-progress edit (the async resolve can land after the user has
      // started toggling/typing on a fresh, empty profile).
      const stored = store.get();
      if (stored) setDraft(stored);
    });
    return () => { cancelled = true; };
  }, [open]);

  const set = <K extends keyof BouncerProfile>(k: K, v: BouncerProfile[K]): void =>
    setDraft((d) => ({ ...d, [k]: v }));

  const submit = (e: Event): void => {
    e.preventDefault();
    getBouncerStore().set({ ...draft, host: draft.host.trim(), username: draft.username.trim() });
    triggerSaved();
  };

  const clear = (): void => {
    getBouncerStore().clear();
    setDraft(EMPTY_BOUNCER);
    triggerSaved();
  };

  return (
    <SectionFrame
      title="Bouncer (ZNC / BNC)"
      description="Connect through an always-on IRC bouncer. Advanced: most people don't need this."
    >
      <form onSubmit={submit} class="user-settings-form">
        <SwitchRow
          title="Use a bouncer"
          description="Set it up once here, then turn it on per server in that server's settings, or add its networks from the directory's Bouncer tab."
          checked={draft.enabled}
          onChange={(v) => set('enabled', v)}
        />
        {draft.enabled && (
          <NestedSettings>
            <div class="user-settings-field-pair">
              <Field label="Host" hint="Your ZNC/BNC hostname.">
                <Input value={draft.host} onInput={(e) => set('host', (e.target as HTMLInputElement).value)}
                  placeholder="znc.example.com" autoComplete="off" spellcheck={false} />
              </Field>
              <Field label="Port">
                <Input type="number" value={String(draft.port)}
                  onInput={(e) => set('port', Number((e.target as HTMLInputElement).value) || 0)} />
              </Field>
            </div>
            <Field label="Username" hint="Your ZNC username. Each server's ZNC network name is added to it.">
              <Input value={draft.username} onInput={(e) => set('username', (e.target as HTMLInputElement).value)}
                placeholder="me" autoComplete="off" spellcheck={false} />
            </Field>
            <Field label="Password" hint="Stored encrypted; never sent to Boson's servers in the clear.">
              <Input type="password" value={draft.password}
                onInput={(e) => set('password', (e.target as HTMLInputElement).value)} autoComplete="off" />
            </Field>
            <SwitchRow title="Use TLS" description="Encrypt the connection to the bouncer." checked={draft.tls} onChange={(v) => set('tls', v)} />
            <SwitchRow
              title="Allow self-signed certificate"
              description="Only for a bouncer with a self-signed certificate you trust."
              checked={draft.tlsInsecure}
              onChange={(v) => set('tlsInsecure', v)}
            />
            {draft.tlsInsecure && (
              <p class="user-settings-warning">
                ⚠ Skips TLS certificate verification, which weakens protection against interception.
              </p>
            )}
            <SwitchRow
              title="Flood control"
              description="Paces what Boson sends so the network doesn't disconnect you. A bouncer paces lines itself, so you can turn this off. Reconnects servers that use the bouncer."
              checked={draft.floodControl !== false}
              onChange={(v) => set('floodControl', v)}
            />
          </NestedSettings>
        )}
        {mode === 'guest' && (
          <p class="user-settings-hint">
            Sign in to sync this bouncer across your devices. It's saved locally on this device for now.
          </p>
        )}
        <div class="user-settings-form-actions">
          {saved && <span class="user-settings-saved">Saved</span>}
          <Button type="button" variant="ghost" onClick={clear}>Clear</Button>
          <Button type="submit" variant="primary"
            disabled={draft.enabled && (!draft.host.trim() || !draft.username.trim())}>
            Save
          </Button>
        </div>
      </form>
    </SectionFrame>
  );
}
