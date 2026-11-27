// The app's DirectoryService, with the account's own data taken from the
// home account when the main session is federated (modules/netauth/
// home-account.ts has the split). A local or SSO account: everything goes
// to this app's API, as before.
//
// Federated, home signed in here: /me, the identity key's wraps, the
// avatar, /me/session (saved networks + preferences), NickServ secrets and
// the bouncer profile are read from and written to the home's API with the
// home token. No copies are made on the remote server.
//
// Federated, home not reachable (signed out there, or its API refuses):
// the profile is the federated session's own (its handle on this server,
// no identity key), so the app still works; the synced data is reported as
// unavailable (reads and writes throw HomeUnavailableError) instead of
// being written to the remote, where it would shadow the home's copy.
import { HttpError, type HttpClient } from '../../shared/http/http.client';
import { DirectoryService } from './directory.service';
import type { BouncerSecretDTO, NickservSecretDTO, User } from './directory.types';
import type { AuthService } from '../auth/auth.service';
import { HomeAccountData, HomeUnavailableError, type HomeAccountHandle } from '../netauth/home-account';

export class AccountDirectory extends DirectoryService {
  constructor(
    http: HttpClient,
    private readonly mainAuth: Pick<AuthService, 'getState'>,
    readonly homeData: HomeAccountData = new HomeAccountData(mainAuth),
  ) {
    super(http);
  }

  // The home account's API for account data; null for a local account.
  // Throws when federated but the home isn't signed in here.
  private async home(): Promise<HomeAccountHandle | null> {
    const f = this.homeData.federated();
    if (!f) return null;
    const h = await this.homeData.home();
    if (!h) throw new HomeUnavailableError(f.homeDomain);
    return h;
  }

  // The profile a federated session has without its home: its handle on
  // this server, nothing to unlock.
  private federatedProfile(): User | null {
    const s = this.mainAuth.getState().session;
    const f = s?.federated;
    if (!s || !f) return null;
    return {
      id: s.user.id,
      handle: f.handle || s.user.username || f.identity,
      display_name: f.identity,
      is_discoverable: false,
      encrypted_user_secret: '',
      created_at: '',
    };
  }

  override async getMe(): Promise<User | null> {
    let h: HomeAccountHandle | null;
    try {
      h = await this.home();
    } catch {
      return this.federatedProfile();
    }
    if (!h) return super.getMe();
    try {
      // No profile at the home yet (the account never finished setting
      // up there): this server's handle stands in; the key is set up when
      // something needs it.
      return (await h.directory.getMe()) ?? this.federatedProfile();
    } catch (err) {
      // The home's API unreachable (offline, CORS) or its token refused:
      // work without it. A server error is retried (DirectoryBloc).
      if (err instanceof HttpError && err.status !== 401) throw err;
      return this.federatedProfile();
    }
  }

  override async setupMe(handle: string, encrypted: string, recovery?: string): Promise<User> {
    const h = await this.home();
    return h ? h.directory.setupMe(handle, encrypted, recovery) : super.setupMe(handle, encrypted, recovery);
  }

  override async updateSecretWraps(input: { passwordBlob?: string; recoveryBlob?: string }): Promise<User> {
    const h = await this.home();
    return h ? h.directory.updateSecretWraps(input) : super.updateSecretWraps(input);
  }

  override async updateMe(patch: { handle?: string }): Promise<User> {
    const h = await this.home();
    return h ? h.directory.updateMe(patch) : super.updateMe(patch);
  }

  override async uploadAvatar(image: Blob): Promise<User> {
    const h = await this.home();
    return h ? h.directory.uploadAvatar(image) : super.uploadAvatar(image);
  }

  override async deleteAvatar(): Promise<User> {
    const h = await this.home();
    return h ? h.directory.deleteAvatar() : super.deleteAvatar();
  }

  override async getSavedSession(): Promise<unknown> {
    const h = await this.home();
    return h ? h.directory.getSavedSession() : super.getSavedSession();
  }

  override async putSavedSession(payload: unknown): Promise<void> {
    const h = await this.home();
    return h ? h.directory.putSavedSession(payload) : super.putSavedSession(payload);
  }

  override async listNickservSecrets(): Promise<NickservSecretDTO[]> {
    const h = await this.home();
    return h ? h.directory.listNickservSecrets() : super.listNickservSecrets();
  }

  override async putNickservSecret(serverId: string, ciphertext: string): Promise<void> {
    const h = await this.home();
    return h ? h.directory.putNickservSecret(serverId, ciphertext) : super.putNickservSecret(serverId, ciphertext);
  }

  override async deleteNickservSecret(serverId: string): Promise<void> {
    const h = await this.home();
    return h ? h.directory.deleteNickservSecret(serverId) : super.deleteNickservSecret(serverId);
  }

  override async getBouncer(): Promise<BouncerSecretDTO | null> {
    const h = await this.home();
    return h ? h.directory.getBouncer() : super.getBouncer();
  }

  override async putBouncer(ciphertext: string): Promise<void> {
    const h = await this.home();
    return h ? h.directory.putBouncer(ciphertext) : super.putBouncer(ciphertext);
  }

  override async deleteBouncer(): Promise<void> {
    const h = await this.home();
    return h ? h.directory.deleteBouncer() : super.deleteBouncer();
  }

  // deleteMe stays on this app's API: from a remote, "delete" is this
  // server's record, never the home account.
}
