// The app's sign-out participants, in one list (see sign-out.ts). A module
// that keeps something of the signed-in person adds its clearForSignOut()
// here; the DirectoryBloc registers its own while it's mounted.

import type { EngineClient } from '../engine';
import type { ChatHistoryStore } from '../history';
import type { IdentityService } from '../identity';
import type { SecureStorage } from '../../shared/secure-storage';
import { registerForSignOut, type SignOutParticipant } from './sign-out';
import { wipeAccountStorage } from './storage-keys';
import { getMemoStore } from '../memos';
import { getNotificationFeed } from '../notifications/feed';
import { getBouncerStore } from '../chat/bouncer.store';
import { getServiceCredentialsStore } from '../chat/services-credentials';
import { clearAvatarsForSignOut } from '../chat/avatar-cache';
import { getDirectorySources } from '../directory/sources';
import { wipeSeenForSignOut } from '../seen';
import { clearOlderSpill } from '../history/older-store';
import { clearSearchSessions } from '../search/search-session';
import { clearImagesForSignOut } from '../../shared/image-cache';
import { clearChannelLevelsForSignOut } from '../ui/notifications.store';
import { clearGuestVoiceIdsForSignOut } from '../voice/guest-id';
import { getNotifier } from '../ui/notifier';
import { getVoiceController } from '../voice';
import { getVideoController } from '../video';
import { getFriendsController } from '../friends';
import { getFiles } from '../files';
import { getNetworkAccounts } from '../netauth/network-accounts';
import { resetCreationCache } from '../chanserv/creation';

export interface AppSignOutDeps {
  engine: EngineClient | null;
  identity: Pick<IdentityService, 'clearStorage'>;
  history: ChatHistoryStore | null;
  secure: SecureStorage;
  // The credential syncs (NickServ passwords, bouncer profile).
  syncs: ReadonlyArray<{ clearForSignOut(): void }>;
}

export function appSignOutParticipants({ engine, identity, history, secure, syncs }: AppSignOutDeps): SignOutParticipant[] {
  // The networks' auth URLs, read before NetworkAccounts forgets them (the
  // storage fallback names their keychain sessions with them).
  let knownAuthUrls: string[] = [];
  return [
    // ---- stop ----
    { name: 'credential-sync', phase: 'stop', clearForSignOut: () => { for (const s of syncs) s.clearForSignOut(); } },
    { name: 'network-accounts.known', phase: 'stop', clearForSignOut: () => { knownAuthUrls = getNetworkAccounts()?.knownAuthUrls() ?? []; } },
    // ---- disconnect ----
    { name: 'voice', phase: 'disconnect', clearForSignOut: () => getVoiceController()?.clearForSignOut() },
    { name: 'video', phase: 'disconnect', clearForSignOut: () => getVideoController()?.clearForSignOut() },
    { name: 'friends', phase: 'disconnect', clearForSignOut: () => getFriendsController()?.clearForSignOut() },
    { name: 'files', phase: 'disconnect', clearForSignOut: () => getFiles()?.clearForSignOut() },
    { name: 'engine', phase: 'disconnect', clearForSignOut: () => engine?.clearForSignOut() },
    { name: 'network-accounts', phase: 'disconnect', clearForSignOut: () => getNetworkAccounts()?.clearForSignOut() },
    // ---- wipe ----
    { name: 'identity', phase: 'wipe', clearForSignOut: async ({ userId }) => { if (userId) await identity.clearStorage(userId); } },
    { name: 'history', phase: 'wipe', clearForSignOut: async ({ userId }) => { if (userId && history) await history.wipeAllForUser(userId); } },
    { name: 'history.older', phase: 'wipe', clearForSignOut: () => clearOlderSpill() },
    { name: 'search', phase: 'wipe', clearForSignOut: () => clearSearchSessions() },
    { name: 'seen', phase: 'wipe', clearForSignOut: ({ userId }) => wipeSeenForSignOut(userId) },
    { name: 'memos', phase: 'wipe', clearForSignOut: () => getMemoStore().clearForSignOut?.() },
    { name: 'notification-feed', phase: 'wipe', clearForSignOut: () => getNotificationFeed().clearForSignOut() },
    { name: 'notification-levels', phase: 'wipe', clearForSignOut: () => clearChannelLevelsForSignOut() },
    { name: 'notifier', phase: 'wipe', clearForSignOut: () => getNotifier().clearForSignOut() },
    { name: 'services-credentials', phase: 'wipe', clearForSignOut: () => getServiceCredentialsStore().clearForSignOut?.() },
    { name: 'bouncer-profile', phase: 'wipe', clearForSignOut: () => getBouncerStore().clearForSignOut?.() },
    { name: 'avatars', phase: 'wipe', clearForSignOut: () => clearAvatarsForSignOut() },
    { name: 'images', phase: 'wipe', clearForSignOut: () => clearImagesForSignOut() },
    { name: 'directories', phase: 'wipe', clearForSignOut: () => getDirectorySources().clearForSignOut() },
    { name: 'guest-voice-id', phase: 'wipe', clearForSignOut: () => clearGuestVoiceIdsForSignOut() },
    { name: 'channel-permissions', phase: 'wipe', clearForSignOut: () => resetCreationCache() },
    // ---- storage (last) ----
    { name: 'storage', phase: 'storage', clearForSignOut: (ctx) => wipeAccountStorage(ctx, secure, undefined, knownAuthUrls) },
  ];
}

export function registerAppSignOut(deps: AppSignOutDeps): () => void {
  const offs = appSignOutParticipants(deps).map(registerForSignOut);
  return () => { for (const off of offs) off(); };
}
