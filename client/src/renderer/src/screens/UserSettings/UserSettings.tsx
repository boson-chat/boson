import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Badge, Button, Card, Divider, Field, Input, Modal } from '@boson/shared';
import {
  clearGuestSession,
  emitGuestChange,
  loadGuestSession,
  saveGuestSession,
} from '../../modules/guest/guest';
import { sanitizeIrcNick } from '../../modules/identity/nick';
import './UserSettings.css';

// Global user-level settings — appearance, identity, account. Opened from
// the gear icon in the title bar. Modal so it floats over whatever screen
// the user is currently on (chat, directory, server settings, login).
//
// Mode-aware: in guest mode the Identity section is editable + the Account
// section offers "Switch to an account"; in authenticated mode Identity
// shows the read-only handle + Account offers Sign out.
//
// Sections are surfaced via a left menu (matching the Server settings page
// pattern) with a scrolling body to the right.

type SectionId = 'identity' | 'appearance' | 'account';

const MENU: ReadonlyArray<{ id: SectionId; label: string; description: string }> = [
  { id: 'identity',   label: 'Identity',   description: 'Display nick + handle' },
  { id: 'appearance', label: 'Appearance', description: 'Theme + density' },
  { id: 'account',    label: 'Account',    description: 'Sign in / out' },
];

interface UserSettingsProps {
  open: boolean;
  onClose: () => void;
  // Authenticated handle when signed in via Supabase. Null in guest mode.
  authedHandle: string | null;
  // Authenticated email (for the Account section). Null in guest mode.
  authedEmail: string | null;
  onSignOut: () => void;
}

export function UserSettings({ open, onClose, authedHandle, authedEmail, onSignOut }: UserSettingsProps) {
  const [section, setSection] = useState<SectionId>('identity');
  const guest = loadGuestSession();
  const mode: 'guest' | 'account' = guest ? 'guest' : 'account';

  return (
    <Modal open={open} onClose={onClose} title="User settings">
      <div class="user-settings">
        <nav class="user-settings-menu" aria-label="Settings sections">
          {MENU.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={section === m.id}
              class={`user-settings-menu-item ${section === m.id ? 'user-settings-menu-item-active' : ''}`}
              onClick={() => setSection(m.id)}
            >
              <span class="user-settings-menu-label">{m.label}</span>
              <span class="user-settings-menu-desc">{m.description}</span>
            </button>
          ))}
        </nav>
        <div class="user-settings-body" role="tabpanel">
          {section === 'identity' && (
            <IdentitySection
              mode={mode}
              authedHandle={authedHandle}
              guestNick={guest?.nick ?? ''}
            />
          )}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'account' && (
            <AccountSection
              mode={mode}
              authedEmail={authedEmail}
              onSignOut={onSignOut}
              onClose={onClose}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

function IdentitySection({ mode, authedHandle, guestNick }: {
  mode: 'guest' | 'account';
  authedHandle: string | null;
  guestNick: string;
}) {
  const [draft, setDraft] = useState(guestNick);
  const [saved, setSaved] = useState(false);

  const submit = (e: Event): void => {
    e.preventDefault();
    if (mode !== 'guest') return;
    const nick = sanitizeIrcNick(draft.trim());
    if (!nick) return;
    saveGuestSession({ nick });
    emitGuestChange();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <SectionFrame
      title="Identity"
      description={mode === 'guest'
        ? "Your local nickname. Changes here apply on the next connect."
        : "Your registered Boson handle, used as your IRC nickname after sanitisation."}
    >
      <Card>
        <div class="user-settings-card-body">
          {mode === 'account' ? (
            <DetailRow label="Handle" value={authedHandle ?? '—'} />
          ) : (
            <form onSubmit={submit} class="user-settings-form">
              <Field
                label="Nick"
                hint="Sanitised on connect — IRC nicks can't contain @, ., or spaces."
              >
                <Input
                  value={draft}
                  onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
                  required
                  autoComplete="off"
                  spellcheck={false}
                />
              </Field>
              <div class="user-settings-form-actions">
                {saved && <span class="user-settings-saved">Saved</span>}
                <Button type="submit" variant="primary" disabled={!draft.trim()}>Save</Button>
              </div>
            </form>
          )}
          <Divider />
          <DetailRow label="Mode" customValue={
            mode === 'guest'
              ? <Badge tone="info">Guest</Badge>
              : <Badge tone="verified">Account</Badge>
          } />
        </div>
      </Card>
    </SectionFrame>
  );
}

function AppearanceSection() {
  return (
    <SectionFrame
      title="Appearance"
      description="Theme and density. Currently locked to the terminal-modern dark scheme; light + density toggles planned."
    >
      <Card>
        <div class="user-settings-card-body">
          <DetailRow label="Theme" customValue={<Badge tone="info">Dark (terminal-modern)</Badge>} />
          <Divider />
          <DetailRow label="Density" value="Comfortable" />
        </div>
      </Card>
    </SectionFrame>
  );
}

function AccountSection({ mode, authedEmail, onSignOut, onClose }: {
  mode: 'guest' | 'account';
  authedEmail: string | null;
  onSignOut: () => void;
  onClose: () => void;
}) {
  if (mode === 'guest') {
    return (
      <SectionFrame
        title="Account"
        description="You're using Boson without an account. Switching to an account lets you register servers + sync across devices."
      >
        <div class="user-settings-actions">
          <Button
            variant="primary"
            onClick={() => {
              clearGuestSession();
              emitGuestChange();
              onClose();
            }}
          >
            Switch to an account
          </Button>
        </div>
      </SectionFrame>
    );
  }
  return (
    <SectionFrame
      title="Account"
      description="Signed in via Supabase. Sign out clears local state on this device and returns you to the login screen."
    >
      <Card>
        <div class="user-settings-card-body">
          <DetailRow label="Email" value={authedEmail ?? '—'} />
        </div>
      </Card>
      <div class="user-settings-actions">
        <Button variant="ghost" onClick={() => { onSignOut(); onClose(); }}>Sign out</Button>
      </div>
    </SectionFrame>
  );
}

interface SectionFrameProps { title: string; description?: string; children: ComponentChildren }
function SectionFrame({ title, description, children }: SectionFrameProps) {
  return (
    <section class="user-settings-section">
      <div class="user-settings-section-head">
        <h2 class="user-settings-section-title">{title}</h2>
        {description && <p class="user-settings-section-desc">{description}</p>}
      </div>
      <div class="user-settings-section-body">{children}</div>
    </section>
  );
}

interface DetailRowProps { label: string; value?: string | null; customValue?: ComponentChildren }
function DetailRow({ label, value, customValue }: DetailRowProps) {
  return (
    <div class="user-settings-row">
      <dt class="user-settings-label">{label}</dt>
      <dd class="user-settings-value">
        {customValue ?? (value ? <span>{value}</span> : <span class="user-settings-empty">—</span>)}
      </dd>
    </div>
  );
}
