import { HttpClient, HttpError } from '../../shared/http/http.client';
import type { Server, ServersResponse, User } from './directory.types';

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
}
