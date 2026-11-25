import { useEffect, useState } from 'preact/hooks';
import {
  Bell, BookOpen, ChevronRight, Globe, Info, KeyRound, Lock, MessageSquareText, Mic, Palette, Server, User,
} from 'lucide-preact';
import { Input, ListRow } from '@boson/shared';
import { Avatar } from '../../shared/Avatar/Avatar';
import type { DirectoryService } from '../../modules/directory';
import { getThemeStore } from '../../modules/ui/theme';
import { getNotificationSettings } from '../../modules/ui/notifications.store';
import { getEmbedSettings } from '../../modules/ui/embeds.store';
import { getPrivacySettings } from '../../modules/ui/privacy.store';
import { getVoiceSettings } from '../../modules/voice';
import { getDirectorySources } from '../../modules/directory/sources';
import { getNetworkAccounts } from '../../modules/netauth/network-accounts';
import { getBouncerStore } from '../../modules/chat/bouncer.store';
import { useFriends } from '../../modules/friends';
import { useUpdateState, type UpdateState } from '../../modules/updater/updater';
import pkg from '../../../../../package.json';
import { GROUP_TITLE, sectionLabel, type GroupId, type MenuEntry, type SectionId } from './sections';

// Phones: User settings opens on this list (the desktop's left menu, as a
// page): the sections in their groups, each with what it's set to now, and
// a chevron. A row opens its section full screen; its header's back arrow
// comes back here. Built like My space's list: nav rows with an icon, the
// channel list's section headings.

const ICON: Record<SectionId, typeof User> = {
  profile: User, account: KeyRound, privacy: Lock,
  appearance: Palette, notifications: Bell, chat: MessageSquareText, voice: Mic,
  directories: BookOpen, networks: Globe, bouncer: Server,
  about: Info,
};

const PHONE_GROUP_TITLE: Record<GroupId, string> = { ...GROUP_TITLE, about: 'About' } as Record<GroupId, string>;

export function PhoneSettingsList({ menu, mode, authedHandle, authedEmail, guestNick, directory, open, onOpen }: {
  menu: ReadonlyArray<MenuEntry>;
  mode: 'guest' | 'account';
  authedHandle: string | null;
  authedEmail: string | null;
  guestNick: string;
  directory: DirectoryService;
  open: boolean;
  onOpen: (id: SectionId) => void;
}) {
  const hint = useSectionHints({ mode, authedHandle, authedEmail, guestNick });
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q
    ? menu.filter((m) => `${sectionLabel(m, mode)} ${hint(m.id)} ${m.keywords}`.toLowerCase().includes(q))
    : menu;
  // Signed in: who you are, at the top (it opens Profile).
  const showCard = mode === 'account' && !q && menu.some((m) => m.id === 'profile');

  return (
    <div class="user-settings-phone-list">
      {menu.length > 4 && (
        <div class="user-settings-phone-search">
          <Input
            type="search"
            value={query}
            placeholder="Search settings"
            aria-label="Search settings"
            autoComplete="off"
            spellcheck={false}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </div>
      )}
      {showCard && (
        <ProfileCard handle={authedHandle} email={authedEmail} directory={directory} open={open} onOpen={() => onOpen('profile')} />
      )}
      {shown.length === 0 && <p class="user-settings-phone-empty">No settings match “{query.trim()}”.</p>}
      <nav aria-label="Settings sections">
        {shown.map((m, i) => {
          const first = i === 0 || shown[i - 1]!.group !== m.group;
          const Icon = ICON[m.id];
          const label = sectionLabel(m, mode);
          const sub = hint(m.id);
          return (
            <div key={m.id} class="user-settings-phone-item">
              {first && menu.length > 2 && (
                <div class="user-settings-phone-heading" aria-hidden="true">{PHONE_GROUP_TITLE[m.group]}</div>
              )}
              <ListRow
                variant="nav"
                size="lg"
                class="user-settings-phone-row"
                leading={<Icon size={16} aria-hidden="true" />}
                title={label}
                subtitle={sub || undefined}
                ariaLabel={sub ? `${label}: ${sub}` : label}
                trailing={<ChevronRight size={16} aria-hidden="true" class="user-settings-phone-chevron" />}
                onClick={() => onOpen(m.id)}
              />
            </div>
          );
        })}
      </nav>
    </div>
  );
}

function ProfileCard({ handle, email, directory, open, onOpen }: {
  handle: string | null;
  email: string | null;
  directory: DirectoryService;
  open: boolean;
  onOpen: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [name, setName] = useState(handle);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void directory.getMe()
      .then((me) => { if (live && me) { setUrl(me.avatar_url ?? null); setName(me.handle); } })
      .catch(() => {});
    return () => { live = false; };
  }, [open, directory]);
  return (
    <ListRow
      variant="nav"
      size="lg"
      class="user-settings-phone-row user-settings-phone-profile"
      leading={<Avatar nick={name || '?'} url={url} size={40} />}
      title={name ?? 'You'}
      subtitle={email ?? undefined}
      ariaLabel={`Your profile: ${name ?? 'you'}`}
      trailing={<ChevronRight size={16} aria-hidden="true" class="user-settings-phone-chevron" />}
      onClick={onOpen}
    />
  );
}

// What each section is set to, in a few words, for the row under its name.
// Read when the list shows (coming back to it from a section re-reads).
function useSectionHints({ mode, authedHandle, authedEmail, guestNick }: {
  mode: 'guest' | 'account';
  authedHandle: string | null;
  authedEmail: string | null;
  guestNick: string;
}): (id: SectionId) => string {
  const { friends, snap } = useFriends();
  const update = useUpdateState();
  return (id) => {
    switch (id) {
      case 'profile': return mode === 'guest' ? guestNick : (authedHandle ?? '');
      case 'account': return mode === 'guest' ? 'Guest, no account' : (authedEmail ?? 'Signed in');
      case 'privacy': {
        const hosts = getPrivacySettings().rememberHosts ? 'hosts remembered' : 'hosts not kept';
        if (!friends || !snap.available) return `Calls need an account · ${hosts}`;
        const calls = { nobody: 'Nobody can call', friends: 'Friends can call', everyone: 'Anyone can call' }[snap.privacy.calls];
        return snap.privacy.doNotDisturb ? `Do not disturb · ${hosts}` : `${calls} · ${hosts}`;
      }
      case 'appearance': {
        const st = getThemeStore().getState();
        const theme = st.themes.find((t) => t.id === st.activeId)?.theme.name;
        return theme ? `${theme} theme` : '';
      }
      case 'notifications': {
        const n = getNotificationSettings();
        if (!n.inApp && !n.enabled) return 'Off';
        const how = n.inApp && n.enabled ? 'Toasts and system' : n.inApp ? 'Toasts only' : 'System only';
        return n.sound ? `${how}, with sound` : how;
      }
      case 'chat': {
        const e = getEmbedSettings();
        if (!e.enabled) return 'Link previews off';
        return e.loadMode === 'auto' ? 'Previews load automatically' : 'Previews load on click';
      }
      case 'voice': return getVoiceSettings().mode === 'ptt' ? 'Push to talk' : 'Voice activity';
      case 'directories': {
        const on = getDirectorySources().list().filter((d) => d.enabled).length;
        return `${on} ${on === 1 ? 'directory' : 'directories'} on`;
      }
      case 'networks': {
        const s = getNetworkAccounts()?.getSnapshot();
        if (!s || s.known.length === 0) return 'None yet';
        const signedIn = s.known.filter((k) => s.sessions[k.authUrl]).length;
        return `${signedIn} of ${s.known.length} signed in`;
      }
      case 'bouncer': {
        const b = getBouncerStore().get();
        return b?.enabled && b.host ? `On · ${b.host}` : 'Off';
      }
      case 'about': return `v${pkg.version}${updateHint(update)}`;
    }
  };
}

function updateHint(s: UpdateState): string {
  switch (s.kind) {
    case 'up-to-date': return ' · up to date';
    case 'available': return ` · v${s.version} available`;
    case 'downloading': return ` · downloading v${s.version}`;
    case 'ready': return ` · v${s.version} ready`;
    default: return '';
  }
}
