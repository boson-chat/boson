import type { ChatMember } from '../../modules/chat';
import { BottomSheet, type SheetAction } from './BottomSheet';
import type { NickProfiles } from './nick-actions';
import { NickProfileDetails, NickProfileHead, useWhois } from './nick-profile';

interface NickSheetProps {
  nick: string;
  /** The channel's record for the nick; null once they've left it. */
  member: ChatMember | null;
  avatarUrl?: string;
  actions: readonly SheetAction[];
  profiles?: NickProfiles;
  onClose: () => void;
}

// Phone layout's stand-in for the nick profile card + right-click menu: a
// tap on a nick (member list, message author or a mention) opens who they
// are and what you can do.
export function NickSheet({ nick, member, avatarUrl, actions, profiles, onClose }: NickSheetProps) {
  const whois = useWhois(nick, profiles);
  return (
    <BottomSheet
      label={nick}
      actions={actions}
      onClose={onClose}
      header={<NickProfileHead nick={nick} member={member} avatarUrl={avatarUrl} size={44} />}
    >
      <NickProfileDetails nick={nick} member={member} whois={whois} />
    </BottomSheet>
  );
}
