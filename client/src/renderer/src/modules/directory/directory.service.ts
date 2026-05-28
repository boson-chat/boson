import { HttpClient, HttpError } from '../../shared/http/http.client';
import type {
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

  async setupMe(handle: string, encryptedUserSecretBase64: string): Promise<User> {
    return this.http.post<User>('/me', {
      handle,
      encrypted_user_secret: encryptedUserSecretBase64,
    });
  }

  // Destructive: drops the caller's user row + cascades through user_server_links
  // and handle_changes. Used by the LoginScreen "Start fresh" recovery flow
  // when the stored encrypted_user_secret cannot be decrypted.
  async deleteMe(): Promise<void> {
    await this.http.delete('/me');
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
}
