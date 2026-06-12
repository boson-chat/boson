import { HttpClient, HttpError } from '../../shared/http/http.client';
import type {
  NickClaimCreateResponse,
  NickClaimPollResponse,
  NickservSecretDTO,
  NickservSecretsListResponse,
  PresenceMatch,
  RegisterServerInput,
  Server,
  ServerWithToken,
  ServersResponse,
  User,
  VerifyResponse,
} from './directory.types';

export interface ListServersParams {
  q?: string;
  lang?: string;
  nsfw?: boolean;
  sort?: 'users' | 'newest' | 'active';
}

export class DirectoryService {
  constructor(private readonly http: HttpClient) {}

  async listServers(params: ListServersParams = {}): Promise<Server[]> {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.lang) qs.set('lang', params.lang);
    if (params.nsfw) qs.set('nsfw', 'true');
    if (params.sort) qs.set('sort', params.sort);
    const path = qs.toString() ? `/servers?${qs}` : '/servers';
    const res = await this.http.get<ServersResponse>(path);
    return res.servers;
  }

  async getMe(): Promise<User | null> {
    try {
      return await this.http.get<User>('/me');
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  async setupMe(
    handle: string,
    encryptedUserSecretBase64: string,
    encryptedUserSecretRecoveryBase64?: string,
  ): Promise<User> {
    return this.http.post<User>('/me', {
      handle,
      encrypted_user_secret: encryptedUserSecretBase64,
      ...(encryptedUserSecretRecoveryBase64
        ? { encrypted_user_secret_recovery: encryptedUserSecretRecoveryBase64 }
        : {}),
    });
  }

  // Replace the password and/or recovery wrap of the caller's user_secret.
  // Used to enroll a recovery code for an existing account (recovery only) or
  // to re-wrap after a password reset (password only). At least one required.
  async updateSecretWraps(input: { passwordBlob?: string; recoveryBlob?: string }): Promise<User> {
    return this.http.put<User>('/me/secret-wraps', {
      ...(input.passwordBlob ? { encrypted_user_secret: input.passwordBlob } : {}),
      ...(input.recoveryBlob ? { encrypted_user_secret_recovery: input.recoveryBlob } : {}),
    });
  }

  // Rename the caller's global handle. Server validates length + uniqueness
  // (case-insensitive against the users_handle_lower_idx) and writes a
  // handle_changes audit row in the same transaction. Throws an
  // HttpError on the wire-level statuses the caller cares about: 409
  // when the handle is taken, 400 when too short, 404 if the row hasn't
  // been created yet via setupMe.
  async updateMe(patch: { handle?: string }): Promise<User> {
    return this.http.patch<User>('/me', patch);
  }

  // Upload a new profile image. The backend validates + resizes + stores it
  // in R2 and returns the refreshed user (with the new avatar_url). Throws
  // HttpError 503 if avatars aren't configured, 413 too large, 400 invalid.
  async uploadAvatar(image: Blob): Promise<User> {
    return this.http.postBlob<User>('/me/avatar', image, image.type || 'application/octet-stream');
  }

  // Remove the caller's profile image. Returns the refreshed user.
  async deleteAvatar(): Promise<User> {
    return this.http.delete<User>('/me/avatar');
  }

  // Publish our current IRC identity on a network so other Boson clients can
  // detect us. Fire-and-forget (204).
  async publishPresence(input: { network: string; nick: string; host?: string; account?: string }): Promise<void> {
    await this.http.put<void>('/me/presence', input);
  }

  // Resolve which of the observed channel members are Boson members.
  async lookupPresence(
    network: string,
    members: Array<{ nick: string; host?: string; account?: string }>,
  ): Promise<PresenceMatch[]> {
    const res = await this.http.post<{ matches: PresenceMatch[] }>('/presence/lookup', { network, members });
    return res?.matches ?? [];
  }

  // Destructive: drops the caller's user row + cascades through user_server_links
  // and handle_changes. Used by the LoginScreen "Start fresh" recovery flow
  // when the stored encrypted_user_secret cannot be decrypted.
  async deleteMe(): Promise<void> {
    await this.http.delete('/me');
  }

  // ---- NickClaim (automated NickServ email confirmation) ----------
  //
  // The signed-in claim flow mints a record on the backend, gets back
  // an `email` to use at REGISTER time, then polls for the captured
  // confirmation code. ChatService.claimNick() wraps these two calls
  // with the actual NickServ register + confirm wire dance.

  async createNickClaim(input: { serverId: string; accountNick: string }): Promise<NickClaimCreateResponse> {
    return this.http.post<NickClaimCreateResponse>('/me/nick-claims', {
      server_id: input.serverId,
      account_nick: input.accountNick,
    });
  }

  async getNickClaim(id: string): Promise<NickClaimPollResponse> {
    return this.http.get<NickClaimPollResponse>(`/me/nick-claims/${encodeURIComponent(id)}`);
  }

  // Server-synced saved session — the client's SessionStore record (servers
  // + joined channels + active cursor) mirrored to the backend so a fresh
  // install on another device lands on the same state. Backend stores the
  // payload as opaque JSONB; the renderer owns the schema (SavedSession in
  // modules/session/session.store.ts).
  async getSavedSession(): Promise<unknown> {
    const res = await this.http.get<{ payload: unknown }>('/me/session');
    return res.payload ?? null;
  }

  async putSavedSession(payload: unknown): Promise<void> {
    await this.http.put('/me/session', { payload });
  }

  // ---- Server submission flow ----

  // Register a new server in the directory. Returns the row plus the
  // freshly-minted verification_token — surfaced exactly once, on this
  // response. Subsequent GETs redact the token unless we hit
  // listMyServers and the row is still pending.
  async registerServer(input: RegisterServerInput): Promise<ServerWithToken> {
    return this.http.post<ServerWithToken>('/servers', input);
  }

  // Rotate the verification token. Used by the "I lost it" path and
  // automatically after a 410 Gone (token-expired) response from verify.
  async regenerateServerToken(serverID: string): Promise<ServerWithToken> {
    return this.http.post<ServerWithToken>(`/servers/${serverID}/regenerate-token`, null);
  }

  // List servers the calling user has registered, any status. The
  // backend returns ServerWithToken for pending rows; verified/lapsed
  // rows come back without the token field.
  async listMyServers(): Promise<ServerWithToken[]> {
    const res = await this.http.get<{ servers: ServerWithToken[]; count: number }>('/servers/me');
    return res.servers ?? [];
  }

  // Update the profile-shaped fields of a server the caller owns. Only
  // the fields the caller actually passes are touched — `undefined`
  // means "leave alone" on every property, so a UI can submit a
  // partial patch without worrying about clobbering other fields.
  // Identity fields (hostname, port, tls) are NOT mutable through this
  // path; the backend rejects them at the route handler.
  async updateServerProfile(
    serverID: string,
    patch: {
      name?: string;
      description?: string;
      tags?: string[];
      languages?: string[];
      is_nsfw?: boolean;
    },
  ): Promise<ServerWithToken> {
    return this.http.patch<ServerWithToken>(`/servers/${serverID}`, patch);
  }

  // Owner-only listing images. `kind` is 'icon' (square) or 'banner' (wide).
  // The backend validates + resizes + stores in R2; returns the refreshed
  // server (with the new icon_url/banner_url).
  async uploadServerImage(serverID: string, kind: 'icon' | 'banner', image: Blob): Promise<Server> {
    return this.http.postBlob<Server>(`/servers/${serverID}/${kind}`, image, image.type || 'application/octet-stream');
  }

  async deleteServerImage(serverID: string, kind: 'icon' | 'banner'): Promise<Server> {
    return this.http.delete<Server>(`/servers/${serverID}/${kind}`);
  }

  // Run the DNS TXT check against the registered hostname. Returns the
  // full report (per-resolver outcomes) on both success AND failure —
  // a 409 partial-match response carries the same body, so the caller
  // can render the resolver matrix without a second request.
  //
  // Throws on 410 (token expired), 403 (not the owner), 404 (server
  // gone), or 429 (rate-limited). The caller is expected to handle
  // each of those by status code via HttpError.
  async verifyServer(serverID: string): Promise<VerifyResponse> {
    try {
      return await this.http.post<VerifyResponse>(`/servers/${serverID}/verify`, null);
    } catch (err) {
      // 409 carries the matrix in the body — we surface it as a normal
      // return so the UI can show "Cloudflare ✓ / Google ✗" without
      // needing a separate error-handling code path.
      if (err instanceof HttpError && err.status === 409 && err.body && typeof err.body === 'object') {
        return err.body as VerifyResponse;
      }
      throw err;
    }
  }

  // ---- NickServ secret sync (E2E-encrypted) -------------------------
  //
  // The client encrypts {nickservPassword, accountName} under a key derived
  // from user_secret and ships only the opaque ciphertext. The server stores
  // blobs it can't read, keyed by (user, server).

  async listNickservSecrets(): Promise<NickservSecretDTO[]> {
    const res = await this.http.get<NickservSecretsListResponse>('/me/nickserv-secrets');
    return res.secrets ?? [];
  }

  async putNickservSecret(serverId: string, ciphertextBase64: string): Promise<void> {
    await this.http.put<NickservSecretDTO>(
      `/me/nickserv-secrets/${encodeURIComponent(serverId)}`,
      { ciphertext: ciphertextBase64 },
    );
  }

  async deleteNickservSecret(serverId: string): Promise<void> {
    await this.http.delete(`/me/nickserv-secrets/${encodeURIComponent(serverId)}`);
  }
}
