// User settings' sections, in three groups (plus About at the end):
//
//   You          Profile · Account & security · Privacy
//   App          Appearance · Notifications · Chat & media · Voice
//   Connections  Directories · Network accounts · Bouncer
//                About
//
// The desktop menu and the phone list are both built from this.

export type SectionId =
  | 'profile' | 'account' | 'privacy'
  | 'appearance' | 'notifications' | 'chat' | 'voice'
  | 'directories' | 'networks' | 'bouncer'
  | 'about';

export type GroupId = 'you' | 'app' | 'connections' | 'about';

export interface MenuEntry {
  id: SectionId;
  label: string;
  group: GroupId;
  /** Words for the phone list's search: the section's settings. */
  keywords: string;
}

export const MENU: ReadonlyArray<MenuEntry> = [
  { id: 'profile',       label: 'Profile',            group: 'you',         keywords: 'avatar profile image picture handle nick name' },
  { id: 'account',       label: 'Account & security', group: 'you',         keywords: 'email password recovery code linked sign-ins sign out log out guest' },
  { id: 'privacy',       label: 'Privacy',            group: 'you',         keywords: 'calls who can call do not disturb dnd friend requests remembered hosts whois join part' },
  { id: 'appearance',    label: 'Appearance',         group: 'app',         keywords: 'theme colours colors dark light network themes custom' },
  { id: 'notifications', label: 'Notifications',      group: 'app',         keywords: 'toasts system sound mentions direct messages friends calls incoming banner full screen' },
  { id: 'chat',          label: 'Chat & media',       group: 'app',         keywords: 'link previews embeds images videos youtube spotify website cards load automatically image cache' },
  { id: 'voice',         label: 'Voice',              group: 'app',         keywords: 'microphone mic speakers input output push to talk sensitivity quality camera data saver screen share' },
  { id: 'directories',   label: 'Directories',        group: 'connections', keywords: 'server browser directory add remove' },
  { id: 'networks',      label: 'Network accounts',   group: 'connections', keywords: 'self-hosted network sign in accounts' },
  { id: 'bouncer',       label: 'Bouncer',            group: 'connections', keywords: 'znc bnc host port tls self-signed flood control' },
  { id: 'about',         label: 'About',              group: 'about',       keywords: 'version update platform source release notes' },
];

// About sits on its own at the end: under a rule on the desktop menu, under
// its own heading in the phone list.
export const GROUP_TITLE: Record<GroupId, string | null> = { you: 'You', app: 'App', connections: 'Connections', about: null };

// Older names for sections (deep links: openUserSettings('identity'), the
// shots harness's ?section=content).
const ALIASES: Readonly<Record<string, SectionId>> = { identity: 'profile', content: 'chat' };

export function resolveSection(id: string | null | undefined): SectionId | null {
  if (!id) return null;
  if (id in ALIASES) return ALIASES[id]!;
  return MENU.some((m) => m.id === id) ? (id as SectionId) : null;
}

/** The entry's label: a guest's "Account" has no security to speak of. */
export function sectionLabel(m: MenuEntry, mode: 'guest' | 'account'): string {
  return m.id === 'account' && mode === 'guest' ? 'Account' : m.label;
}
