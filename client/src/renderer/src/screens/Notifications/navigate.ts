// Going where a notification points: a conversation, MY's Friends or Calls,
// a voice channel's join view. Screens register the parts they own.
import { publishOpenConversation } from '../../modules/inbox-nav/inbox-nav';
import { requestThread } from '../../modules/chat/thread-nav';
import { openMy, setFriendsUi } from '../Friends/friends-ui';
import { setVoiceUi } from '../ChatLayout/VoiceRooms';
import type { ToastRoom } from '../../modules/notifications/feed';

/** A conversation on a server: a DM opens in MY, a channel on its server.
 *  With `message` (a reply's notification), the thread it's in opens too. */
export function openConversation(serverId: string, channel: string | null, message?: { messageId?: string; msgid?: string }): void {
  const dm = !!channel && !/^[#&]/.test(channel);
  if (channel && message) requestThread({ serverId, channel, ...message });
  setFriendsUi(dm ? { my: true, myView: 'chat', phone: 'chat' } : { my: false, phone: channel ? 'chat' : null });
  publishOpenConversation({ serverId, target: channel });
}

export function openFriends(): void { openMy('friends'); }
export function openCalls(): void { openMy('calls'); }

// ChatLayout's Join (it may switch servers first); the plain join view
// until one is registered.
let joiner: ((room: ToastRoom) => void) | null = null;
export function setVoiceJoiner(fn: ((room: ToastRoom) => void) | null): void { joiner = fn; }
export function joinVoice(room: ToastRoom): void {
  if (joiner) { joiner(room); return; }
  setFriendsUi({ my: false, phone: null });
  setVoiceUi({ view: { host: room.host, roomId: room.roomId, serverName: room.serverName } });
}
