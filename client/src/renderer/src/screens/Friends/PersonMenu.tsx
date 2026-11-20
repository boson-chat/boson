import { useEffect, useState } from 'preact/hooks';
import { Ban, Phone, PhoneOff, UserPlus, Video } from 'lucide-preact';
import { Button, MenuItem, MenuSeparator } from '@boson/shared';
import { useFriends, type Relation } from '../../modules/friends';
import { useFriendsUi } from './friends-ui';
import './PersonMenu.css';

// Friend and call actions for someone's name (member list, message
// authors): Call / Video call, or why you can't; Add friend / Remove friend
// / Accept / Cancel request; Block / Unblock. Only for people on your own
// Boson network, when signed in. Variant "menu" sits in the right-click
// menu and the profile card; "sheet" in the phone's bottom sheet, with big
// call buttons.

export const RELATION_TEXT: Record<Relation['relation'], string> = {
  friend: 'Friend', none: 'Not a friend', incoming: 'Wants to be your friend', outgoing: 'Friend request sent', blocked: 'Blocked',
};

const FRIEND_LABEL: Record<Relation['relation'], string> = {
  friend: 'Remove friend', none: 'Add friend', incoming: 'Accept friend request', outgoing: 'Cancel friend request', blocked: 'Add friend',
};

export function whyNoCall(rel: Relation, phone = false): string {
  const name = rel.user.username;
  switch (rel.call) {
    case 'you_blocked': return `You blocked ${name}. Unblock them to call.`;
    case 'calls_off': return `${name} isn't taking calls right now.`;
    case 'friends_only':
      return phone ? `${name} only takes calls from friends. Add them as a friend first.` : `${name} only takes calls from friends. Send a friend request first.`;
  }
  return '';
}

// The relation with nick, when there's a person menu for them.
export function usePersonRelation(nick: string, account?: string): Relation | null {
  const { friends, snap } = useFriends();
  const { host } = useFriendsUi();
  const name = account || nick;
  const here = !!friends && friends.peopleHere(host) && !friends.isMe(name);
  const [rel, setRel] = useState<Relation | null>(null);
  useEffect(() => {
    if (!here || !friends) { setRel(null); return; }
    let live = true;
    void friends.relation(name).then((r) => { if (live) setRel(r); });
    return () => { live = false; };
  }, [here, friends, name, snap.relationsVersion]);
  return here ? rel : null;
}

interface Props {
  nick: string;
  account?: string;
  variant: 'menu' | 'sheet';
  // After an action (closes the menu).
  onDone?: () => void;
}

export function PersonMenu({ nick, account, variant, onDone }: Props) {
  const { friends } = useFriends();
  const rel = usePersonRelation(nick, account);
  if (!friends || !rel) return null;
  const name = rel.user.username;
  const r = rel.relation;
  const canCall = rel.call === 'ok' && r !== 'blocked';
  const done = (fn: () => void) => () => { fn(); onDone?.(); };
  const call = (video: boolean) => done(() => { void friends.call(name, video); });
  const friendAction = done(() => {
    if (r === 'friend') void friends.removeFriend(rel.user);
    else if (r === 'incoming') void friends.acceptRequest(rel.user);
    else if (r === 'outgoing') void friends.deleteRequest(rel.user);
    else void friends.sendRequest(name);
  });
  const blockAction = done(() => {
    if (r === 'blocked') void friends.unblock(rel.user);
    else void friends.block(name);
  });

  const friendIcon = <UserPlus />;
  const blockIcon = <Ban />;
  if (variant === 'sheet') {
    return (
      <div class="person-sheet">
        <div class="person-sheet-relation">{RELATION_TEXT[r]}</div>
        {canCall ? (
          <div class="person-sheet-calls">
            <Button variant="success" size="lg" fullWidth icon={<Phone />} onClick={call(false)}>Call</Button>
            <Button variant="secondary" tone="success" size="lg" fullWidth icon={<Video />} onClick={call(true)}>Video call</Button>
          </div>
        ) : (
          <p class="person-sheet-why">{whyNoCall(rel, true)}</p>
        )}
        <div class="person-sheet-opts" role="menu" aria-label={`${name}: ${RELATION_TEXT[r]}`}>
          <MenuItem size="lg" icon={friendIcon} iconTone="accent" onClick={friendAction}>{FRIEND_LABEL[r]}</MenuItem>
          <MenuItem size="lg" icon={blockIcon} danger onClick={blockAction}>{r === 'blocked' ? 'Unblock' : 'Block'}</MenuItem>
        </div>
      </div>
    );
  }
  return (
    <div class="person-menu" role="group" aria-label={`${name}: ${RELATION_TEXT[r]}`}>
      <div class="person-menu-relation">{RELATION_TEXT[r]}</div>
      {canCall ? (
        <>
          <MenuItem class="person-menu-item" icon={<Phone />} iconTone="success" onClick={call(false)}>Call</MenuItem>
          <MenuItem class="person-menu-item" icon={<Video />} iconTone="success" onClick={call(true)}>Video call</MenuItem>
        </>
      ) : (
        <div class="person-menu-why">
          <span class="person-menu-why-head"><PhoneOff size={14} aria-hidden="true" />Call</span>
          {whyNoCall(rel)}
        </div>
      )}
      <MenuSeparator />
      <MenuItem class="person-menu-item" icon={friendIcon} iconTone="accent" onClick={friendAction}>{FRIEND_LABEL[r]}</MenuItem>
      <MenuItem class="person-menu-item" icon={blockIcon} danger onClick={blockAction}>{r === 'blocked' ? 'Unblock' : 'Block'}</MenuItem>
      <MenuSeparator />
    </div>
  );
}
