import type { TokenProvider } from '../../shared/http/http.client';
import type { ApiTransport } from '../../shared/http/transport';
import type { ListServersParams } from './directory.service';
import type { Server } from './directory.types';
import { MultiDirectory, unreachable } from './multi-directory';
import { NetworkOwnerApi, type HostingApi } from './network-api';
import type { DirectorySource, DirectorySources } from './sources';

// The app's view of the network directories: the merged browser, owner API
// clients for the directories that accept our sign-in, and which listings
// the user owns (so the Edit tab shows up on them).
export class NetworkDirectories {
  readonly browser: MultiDirectory;
  private owned = new Map<string, Set<string>>();

  constructor(
    readonly sources: DirectorySources,
    private readonly tokens: TokenProvider,
    private readonly transport?: ApiTransport,
    legacy?: (p?: ListServersParams) => Promise<Server[]>,
  ) {
    this.browser = new MultiDirectory({
      sources: () => sources.list(),
      ready: () => sources.whenSynced(),
      transport,
      legacy,
      owned: () => this.owned,
    });
  }

  // Owner client for a directory, or null when it doesn't accept our
  // accounts (we never send our token there).
  ownerApi(url: string): NetworkOwnerApi | null {
    const src = this.sources.find(url);
    if (!src || !this.sources.acceptsOurAccounts(src)) return null;
    return new NetworkOwnerApi(src, this.tokens, this.transport);
  }

  // The hosting modal's API for a directory. For the default one, a
  // deployment without the directory service yet (it doesn't answer) falls
  // back to the legacy /servers owner API, as browse does.
  hostingApi(url: string, legacy?: HostingApi): HostingApi | null {
    const api = this.ownerApi(url);
    if (!api || !legacy || !api.source.isDefault) return api;
    return new FallbackHostingApi(api, legacy);
  }

  ownerApiFor(server: Server): HostingApi | null {
    return server.source ? this.ownerApi(server.source.url) : null;
  }

  hostable(): DirectorySource[] {
    return this.sources.hostable().filter((s) => s.enabled || s.isDefault);
  }

  // Which listings the signed-in user owns, per directory. Best-effort: a
  // directory that fails keeps its previous answer.
  async refreshOwned(): Promise<void> {
    await Promise.all(this.hostable().map(async (src) => {
      const api = this.ownerApi(src.url);
      if (!api) return;
      try {
        const mine = await api.listMyServers();
        this.owned.set(src.url, new Set(mine.map((s) => s.id)));
      } catch { /* keep the last answer */ }
    }));
  }

  clearOwned(): void {
    this.owned = new Map();
  }
}

// /v1 first; if the directory doesn't answer the first call, the legacy API
// for the rest of this session (one modal's lifetime).
export class FallbackHostingApi implements HostingApi {
  private mode: 'unknown' | 'primary' | 'legacy' = 'unknown';

  constructor(private readonly primary: HostingApi, private readonly legacy: HostingApi) {}

  get usingLegacy(): boolean { return this.mode === 'legacy'; }

  private async run<T>(call: (api: HostingApi) => Promise<T>): Promise<T> {
    if (this.mode === 'legacy') return call(this.legacy);
    try {
      const out = await call(this.primary);
      this.mode = 'primary';
      return out;
    } catch (err) {
      if (this.mode === 'unknown' && unreachable(err)) {
        this.mode = 'legacy';
        return call(this.legacy);
      }
      throw err;
    }
  }

  listMyServers() { return this.run((a) => a.listMyServers()); }
  registerServer(input: Parameters<HostingApi['registerServer']>[0]) { return this.run((a) => a.registerServer(input)); }
  verifyServer(id: string) { return this.run((a) => a.verifyServer(id)); }
  regenerateServerToken(id: string) { return this.run((a) => a.regenerateServerToken(id)); }
  updateServerProfile(id: string, patch: Parameters<HostingApi['updateServerProfile']>[1]) { return this.run((a) => a.updateServerProfile(id, patch)); }
  uploadServerImage(id: string, kind: 'icon' | 'banner', image: Blob) { return this.run((a) => a.uploadServerImage(id, kind, image)); }
  deleteServerImage(id: string, kind: 'icon' | 'banner') { return this.run((a) => a.deleteServerImage(id, kind)); }
  async deleteServer(id: string): Promise<void> {
    await this.run(async (a) => {
      if (!a.deleteServer) throw new Error('Removing a listing isn’t supported here.');
      await a.deleteServer(id);
    });
  }
  supportsDelete(): boolean { return this.mode !== 'legacy' || this.legacy.deleteServer !== undefined; }
}
