import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { ChevronLeft } from 'lucide-preact';
import { Modal, PageHeader } from '@boson/shared';
import { loadGuestSession } from '../../modules/guest/guest';
import type { DirectoryService } from '../../modules/directory';
import type { IdentityService } from '../../modules/identity';
import type { AuthService } from '../../modules/auth';
import { getVoiceController } from '../../modules/voice';
import { getNetworkAccounts } from '../../modules/netauth/network-accounts';
import { useNarrow } from '../../shared/narrow';
import { BACK_TO_SETTINGS, SettingsMenu } from '../../shared/settings/SettingsNav';
import { SectionFrame } from './SettingsFrame';
import { ProfileSection } from './ProfileSection';
import { AccountSection } from './AccountSection';
import { PrivacySection } from './PrivacySection';
import { AppearancePanel } from './AppearancePanel';
import { NotificationsSection } from './NotificationsSection';
import { ChatMediaSection } from './ChatMediaSection';
import { VoiceSettingsSection } from './VoiceSettings';
import { DirectoriesSection } from './DirectoriesSection';
import { NetworkAccountsSection } from './NetworkAccountsSection';
import { BouncerSection } from './BouncerSection';
import { AboutSection } from './AboutSection';
import { PhoneSettingsList } from './PhoneSettingsList';
import { GROUP_TITLE, MENU, resolveSection, sectionLabel, type SectionId } from './sections';
import './UserSettings.css';

export { UpdateActions, browserName, platformLabel } from './AboutSection';
export { resolveSection, type SectionId } from './sections';

// Global user-level settings, opened from the title bar's gear (and the
// voice bar's, the bell's, MY's). A modal, so it floats over whatever screen
// the user is on. The sections are in three groups (sections.ts):
//
//   desktop  a left menu with group headings, the chosen section beside it
//   phones   a list of the sections (with what each is set to); a row opens
//            its section full screen, with a back arrow to the list
//
// Mode-aware: a guest edits their nick in Profile and finds "Switch to an
// account" under Account; before signing in only Appearance and About show.

interface UserSettingsProps {
  open: boolean;
  onClose: () => void;
  // Authenticated handle when signed in to an account. Null in guest mode.
  // Cached on session.user_metadata.handle — the Profile section
  // re-syncs from the authoritative backend (/me) when opened.
  authedHandle: string | null;
  // Authenticated email (for Account & security). Null in guest mode.
  authedEmail: string | null;
  onSignOut: () => void;
  // Required for the Profile section's authoritative read + rename.
  // The renderer-only test harness wires these via buildApp().
  directory: DirectoryService;
  // Used by Account & security's recovery-code enroll/regenerate flow.
  identity: IdentityService;
  auth: AuthService;
  // Open at this section (e.g. 'voice' from the voice bar's gear). Old ids
  // ('identity', 'content') still work.
  initialSection?: string | null;
  // Neither signed in nor a guest (the login screen): only what applies
  // before signing in — Privacy (this device's), Appearance and About.
  signedOut?: boolean;
}

const SIGNED_OUT_SECTIONS: ReadonlySet<SectionId> = new Set(['privacy', 'appearance', 'about']);

export function UserSettings({ open, onClose, authedHandle, authedEmail, onSignOut, directory, identity, auth, initialSection, signedOut = false }: UserSettingsProps) {
  const [chosen, setSection] = useState<SectionId>('profile');
  // Phones: null while the list shows.
  const [phoneSection, setPhoneSection] = useState<SectionId | null>(null);
  const phone = useNarrow();
  const guest = loadGuestSession();
  const mode: 'guest' | 'account' = guest ? 'guest' : 'account';
  // Voice settings only where there's voice (the desktop app); network
  // accounts only where they're supported.
  const hasVoice = getVoiceController() !== null;
  const hasNetworks = getNetworkAccounts() !== null;
  const menu = MENU.filter((m) => {
    if (signedOut) return SIGNED_OUT_SECTIONS.has(m.id);
    if (m.id === 'voice') return hasVoice;
    if (m.id === 'networks') return hasNetworks;
    return true;
  });
  const section: SectionId = menu.some((m) => m.id === chosen) ? chosen : menu[0]!.id;
  useEffect(() => {
    if (!open) return;
    const want = resolveSection(initialSection);
    const ok = want && menu.some((m) => m.id === want) ? want : null;
    if (ok) setSection(ok);
    // A phone opens on the list, or straight into the section asked for.
    setPhoneSection(ok);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialSection]);

  const body = (id: SectionId) => (
    <>
      {id === 'profile' && (
        <ProfileSection
          mode={mode}
          authedHandle={authedHandle}
          guestNick={guest?.nick ?? ''}
          directory={directory}
          auth={auth}
          open={open}
        />
      )}
      {id === 'account' && (
        <AccountSection
          mode={mode}
          authedEmail={authedEmail}
          onSignOut={onSignOut}
          onClose={onClose}
          directory={directory}
          identity={identity}
          auth={auth}
          open={open}
        />
      )}
      {id === 'privacy' && <PrivacySection mode={mode} />}
      {id === 'appearance' && (
        <SectionFrame
          title="Appearance"
          description="Pick a theme, or customize one: every colour in the app comes from it. Changes apply instantly."
        >
          <AppearancePanel />
        </SectionFrame>
      )}
      {id === 'notifications' && <NotificationsSection />}
      {id === 'chat' && <ChatMediaSection />}
      {id === 'voice' && hasVoice && <VoiceSettingsSection open={open} />}
      {id === 'directories' && <DirectoriesSection />}
      {id === 'networks' && hasNetworks && <NetworkAccountsSection open={open} />}
      {id === 'bouncer' && <BouncerSection mode={mode} open={open} />}
      {id === 'about' && <AboutSection />}
    </>
  );

  if (phone) {
    const current = phoneSection && menu.find((m) => m.id === phoneSection);
    return (
      <Modal open={open} onClose={onClose} title="User settings">
        {current ? (
          <div class="user-settings user-settings-phone">
            <PageHeader
              layout="phone"
              class="user-settings-phone-head"
              title={sectionLabel(current, mode)}
              onBack={() => setPhoneSection(null)}
              backLabel={BACK_TO_SETTINGS}
              backIcon={<ChevronLeft size={20} />}
            />
            <div class="user-settings-phone-body" role="region" aria-label={sectionLabel(current, mode)}>
              {body(current.id)}
            </div>
          </div>
        ) : (
          <div class="user-settings user-settings-phone">
            <PhoneSettingsList
              menu={menu}
              mode={mode}
              authedHandle={authedHandle}
              // A federated account has no email here: its identity
              // (alice@boson.chat) says who it is.
              authedEmail={authedEmail ?? (typeof auth.getState === 'function' ? auth.getState().session?.federated?.identity : null) ?? null}
              guestNick={guest?.nick ?? ''}
              directory={directory}
              open={open}
              onOpen={(id) => { setSection(id); setPhoneSection(id); }}
            />
          </div>
        )}
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title="User settings">
      <DesktopSettings
        menu={menu}
        mode={mode}
        signedOut={signedOut}
        section={section}
        onSection={setSection}
      >
        {body(section)}
      </DesktopSettings>
    </Modal>
  );
}

// The desktop's left menu (group headings, About under a rule) and the
// chosen section beside it.
function DesktopSettings({ menu, mode, signedOut, section, onSection, children }: {
  menu: typeof MENU;
  mode: 'guest' | 'account';
  signedOut: boolean;
  section: SectionId;
  onSection: (id: SectionId) => void;
  children: ComponentChildren;
}) {
  return (
    <div class="user-settings">
      <SettingsMenu
        class="user-settings-menu"
        entries={menu.map((m) => ({ ...m, label: sectionLabel(m, mode) }))}
        groupTitle={(g) => GROUP_TITLE[g]}
        headings={!signedOut}
        selected={section}
        onSelect={onSection}
      />
      <div class="user-settings-body" role="tabpanel">{children}</div>
    </div>
  );
}
