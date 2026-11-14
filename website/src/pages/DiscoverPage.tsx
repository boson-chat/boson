import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { AtomLoader, Badge, Card, Toggle } from '@boson/shared';
import { useLatestRelease } from '../hooks/useLatestRelease';
import './DiscoverPage.css';

// What a card shows of a directory listing (/v1/networks; the legacy
// /servers rows map onto it too, see toServer).
interface Server {
  id: string;
  hostname: string;
  port: number;
  tls: boolean;
  name: string;
  description?: string;
  tags: string[];
  languages: string[];
  is_nsfw: boolean;
  is_featured: boolean;
  health_status: 'up' | 'down' | 'unknown';
  verification_status: 'pending' | 'verified' | 'lapsed';
  user_count?: number;
  // Owner-set listing imagery, served from the CDN. Absent when unset; the
  // card falls back to the initials tile (icon) / no banner.
  icon_url?: string;
  banner_url?: string;
}

// Escape a URL for safe interpolation into a CSS url("…"): neutralise the
// closing quote, backslash and parens so a crafted banner URL can't break
// out of the declaration. The URL is backend-issued (our CDN) but we don't
// trust it into a style string unescaped.
function cssUrl(url: string): string {
  return url.replace(/[\\"()]/g, '\\$&');
}

// The network directory (directory.boson.chat): paged /v1/networks with
// server-side search, CORS-open for GETs. Until it is live everywhere, a
// directory that doesn't answer falls back to the boson API's legacy
// /servers list (one page). In dev, vite.config.ts proxies `/servers` →
// VITE_BOSON_API_URL so that fallback never crosses origins.
export const DIRECTORY_URL = (import.meta.env.VITE_DIRECTORY_URL as string | undefined) ?? 'https://directory.boson.chat';
const API_BASE = import.meta.env.DEV ? '' : ((import.meta.env.VITE_BOSON_API_URL as string | undefined) ?? 'https://api.boson.chat');
const PAGE_SIZE = 24;
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Build the `boson://` deep-link the desktop app handles. The installed
 * app registers the scheme; clicking the link from a normal
 * browser hands the URL off to the installed app and triggers a
 * directory join. Hostname/port/tls are everything the app needs;
 * `name` is optional and just shows in the title bar / local-servers
 * list if the directory entry isn't yet known to the client.
 */
function joinUrl(s: Server): string {
  const params = new URLSearchParams({
    host: s.hostname,
    port: String(s.port),
    tls: s.tls ? '1' : '0',
    name: s.name,
  });
  return `boson://join?${params.toString()}`;
}

// One /v1 network (or legacy /servers row) → the card's shape.
export function toServer(n: Record<string, unknown>): Server {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const status = str(n.status) ?? str(n.verification_status);
  const health = n.health_status === 'up' || n.health_status === 'down' ? n.health_status : 'unknown';
  return {
    id: String(n.id ?? n.hostname ?? ''),
    hostname: String(n.hostname ?? ''),
    port: typeof n.port === 'number' ? n.port : 6697,
    tls: n.tls !== false,
    name: str(n.name) ?? String(n.hostname ?? ''),
    description: str(n.description),
    tags: list(n.tags),
    languages: list(n.languages),
    is_nsfw: n.is_nsfw === true,
    is_featured: n.is_featured === true,
    health_status: health,
    verification_status: status === 'verified' || status === 'lapsed' ? status : 'pending',
    user_count: typeof n.user_count === 'number' ? n.user_count : undefined,
    icon_url: str(n.icon_url),
    banner_url: str(n.banner_url),
  };
}

interface Query { q: string; lang: string; nsfw: boolean }

// "fi" → "Suomi" (the language's own name); anything else as given.
function languageLabel(code: string): string {
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(code)) return code;
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    if (name && name.toLowerCase() !== code.toLowerCase()) return name.charAt(0).toUpperCase() + name.slice(1);
  } catch { /* not a valid tag */ }
  return code;
}

export function networksUrl(query: Query, cursor: string | null): string {
  const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (query.q) qs.set('q', query.q);
  if (query.lang !== 'all') qs.set('lang', query.lang);
  if (query.nsfw) qs.set('nsfw', 'true');
  if (cursor) qs.set('cursor', cursor);
  return `${DIRECTORY_URL}/v1/networks?${qs}`;
}

interface Page { servers: Server[]; next: string | null; total: number | null; legacy: boolean }

async function fetchPage(query: Query, cursor: string | null): Promise<Page> {
  let res: Response | null = null;
  try {
    res = await fetch(networksUrl(query, cursor), { headers: { Accept: 'application/json' } });
  } catch {
    res = null;
  }
  if (res && res.ok) {
    const data = (await res.json()) as { networks?: unknown[]; next_cursor?: string | null; total_estimate?: number };
    const rows = Array.isArray(data.networks) ? data.networks : [];
    return {
      servers: rows.map((n) => toServer(n as Record<string, unknown>)),
      next: data.next_cursor || null,
      total: typeof data.total_estimate === 'number' ? data.total_estimate : null,
      legacy: false,
    };
  }
  // A 4xx is the directory answering ("bad query"): report it as is.
  if (res && res.status >= 400 && res.status < 500 && res.status !== 404) throw new Error(`HTTP ${res.status}`);
  if (cursor) throw new Error(res ? `HTTP ${res.status}` : 'The directory didn\u2019t answer');
  // Unreachable (or not deployed yet): the legacy single-page list,
  // filtered here the way the old page did.
  const legacy = await fetch(`${API_BASE}/servers`);
  if (!legacy.ok) throw new Error(`HTTP ${legacy.status}`);
  const data = (await legacy.json()) as { servers?: unknown[] };
  const q = query.q.toLowerCase();
  const servers = (Array.isArray(data.servers) ? data.servers : []).map((n) => toServer(n as Record<string, unknown>))
    .filter((s) => query.nsfw || !s.is_nsfw)
    .filter((s) => query.lang === 'all' || s.languages.includes(query.lang))
    .filter((s) => !q || s.name.toLowerCase().includes(q) || s.hostname.toLowerCase().includes(q)
      || (s.description ?? '').toLowerCase().includes(q) || s.tags.some((t) => t.toLowerCase().includes(q)));
  return { servers, next: null, total: servers.length, legacy: true };
}

// Language codes from /v1/facets, most-listed first.
async function fetchLanguages(nsfw: boolean): Promise<string[]> {
  try {
    const res = await fetch(`${DIRECTORY_URL}/v1/facets${nsfw ? '?nsfw=true' : ''}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { languages?: unknown };
    const raw = data.languages;
    const items: Array<{ value: string; count: number }> = [];
    if (Array.isArray(raw)) {
      for (const it of raw) {
        if (typeof it === 'string') items.push({ value: it, count: 0 });
        else if (it && typeof it === 'object') {
          const o = it as Record<string, unknown>;
          const v = [o.language, o.lang, o.code, o.value, o.name].find((x) => typeof x === 'string') as string | undefined;
          if (v) items.push({ value: v, count: typeof o.count === 'number' ? o.count : 0 });
        }
      }
    } else if (raw && typeof raw === 'object') {
      for (const [value, count] of Object.entries(raw)) items.push({ value, count: typeof count === 'number' ? count : 0 });
    }
    return items.sort((a, b) => b.count - a.count).slice(0, 8).map((i) => i.value);
  } catch {
    return [];
  }
}

export function DiscoverPage() {
  const [servers, setServers] = useState<Server[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [language, setLanguage] = useState<'all' | string>('all');
  const [showNsfw, setShowNsfw] = useState(false);
  const [next, setNext] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [facetLanguages, setFacetLanguages] = useState<string[]>([]);
  const release = useLatestRelease();
  // Drops answers to a search the user has typed past.
  const generation = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const current: Query = useMemo(() => ({ q: debounced, lang: language, nsfw: showNsfw }), [debounced, language, showNsfw]);

  useEffect(() => {
    const gen = ++generation.current;
    setError(null);
    setMoreError(null);
    // Keep the previous rows on screen while refining a search.
    fetchPage(current, null)
      .then((page) => {
        if (gen !== generation.current) return;
        setServers(page.servers);
        setNext(page.next);
        setTotal(page.total);
        setLegacy(page.legacy);
      })
      .catch((err: unknown) => {
        if (gen !== generation.current) return;
        setServers(null);
        setError(err instanceof Error ? err.message : 'Failed to load directory');
      });
  }, [current]);

  useEffect(() => {
    let live = true;
    void fetchLanguages(showNsfw).then((l) => { if (live) setFacetLanguages(l); });
    return () => { live = false; };
  }, [showNsfw]);

  const loadMore = (): void => {
    if (!next || loadingMore) return;
    const gen = generation.current;
    setLoadingMore(true);
    setMoreError(null);
    fetchPage(current, next)
      .then((page) => {
        if (gen !== generation.current) return;
        setServers((prev) => {
          const seen = new Set((prev ?? []).map((s) => s.id));
          return [...(prev ?? []), ...page.servers.filter((s) => !seen.has(s.id))];
        });
        setNext(page.next);
      })
      .catch((err: unknown) => {
        if (gen === generation.current) setMoreError(err instanceof Error ? err.message : 'Failed to load more');
      })
      .finally(() => { if (gen === generation.current) setLoadingMore(false); });
  };

  // Language chips: the directory's facets, or (legacy list) whatever the
  // loaded rows carry. The selected one always stays visible.
  const languages = useMemo(() => {
    let list = facetLanguages;
    if (list.length === 0 && servers) {
      const seen = new Set<string>();
      for (const s of servers) for (const lang of s.languages) seen.add(lang);
      list = Array.from(seen).sort();
    }
    return language !== 'all' && !list.includes(language) ? [...list, language] : list;
  }, [facetLanguages, servers, language]);

  const filtered = servers;
  const filtering = debounced !== '' || language !== 'all';

  return (
    <>
      <section class="section discover-hero">
        <div class="container">
          <p class="eyebrow">Discover · IRC server directory</p>
          <h1 style="max-width: 22ch;">A live index of every server registered with Boson.</h1>
          <p class="lead" style="margin-top: 20px;">
            Browse from the web, then jump straight into Boson with one click. Every server here
            speaks SASL over TLS — the same handshake the desktop client uses on every connect.
          </p>
          <p class="discover-register">
            Run a server? <a href={DIRECTORY_URL} class="docs-link">List it at {new URL(DIRECTORY_URL).host}</a>{' '}
            — sign in with your Boson account and verify with a DNS record.
          </p>
        </div>
      </section>

      <section class="section discover-section">
        <div class="container">
          <div class="discover-controls">
            <input
              type="search"
              class="discover-search"
              placeholder="Search servers, hostnames, tags…"
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            />
            <div class="discover-langs" role="tablist" aria-label="Filter by language">
              <button
                type="button"
                role="tab"
                aria-selected={language === 'all'}
                class={language === 'all' ? 'is-active' : ''}
                onClick={() => setLanguage('all')}
              >
                All
              </button>
              {languages.map((lang) => (
                <button
                  key={lang}
                  type="button"
                  role="tab"
                  aria-selected={language === lang}
                  class={language === lang ? 'is-active' : ''}
                  onClick={() => setLanguage(lang)}
                >
                  {languageLabel(lang)}
                </button>
              ))}
            </div>
            <div class="discover-nsfw">
              <Toggle checked={showNsfw} onChange={setShowNsfw} label="Show NSFW" />
            </div>
          </div>

          {error ? (
            <div class="discover-state discover-state-error">
              <p>Couldn't load the directory. {error}</p>
              <p class="muted">
                If you're offline, you can still install Boson and add any server you know about
                manually — see <a href="/docs#add-manual" class="docs-link">Add a server manually</a>.
              </p>
            </div>
          ) : filtered === null ? (
            <div class="discover-state">
              <AtomLoader size={36} />
              <span>Loading directory…</span>
            </div>
          ) : filtered.length === 0 ? (
            // Two empty-state scenarios: (a) the whole directory is empty
            // (typical right now — registration UI isn't shipped yet), or
            // (b) we have servers but the current filter combo hides all
            // of them. Pick the message that matches reality.
            !filtering && !showNsfw ? (
              <div class="discover-state">
                <p>The directory is empty.</p>
                <p class="muted" style="max-width: 50ch;">
                  No servers have been listed yet. Run one?{' '}
                  <a href={DIRECTORY_URL} class="docs-link">List it at {new URL(DIRECTORY_URL).host}</a>{' '}
                  (see <a href="/docs#host-start" class="docs-link">List in the directory</a>).
                  In the meantime you can connect to any IRC server you know
                  about by hand via{' '}
                  <a href="/docs#add-manual" class="docs-link">Advanced mode</a>{' '}
                  in the app.
                </p>
              </div>
            ) : (
              <div class="discover-state">
                <p>No servers match those filters.</p>
              </div>
            )
          ) : (
            <>
            <p class="discover-count" role="status">
              {total !== null && total > filtered.length
                ? `Showing ${filtered.length} of about ${total.toLocaleString()} servers`
                : `${filtered.length.toLocaleString()} ${filtered.length === 1 ? 'server' : 'servers'}`}
              {legacy ? ' (from the older boson.chat list)' : ''}
            </p>
            <ul class="discover-grid">
              {filtered.map((s) => (
                <li key={s.id}>
                  <Card variant="raised">
                    <article class="discover-card">
                      {s.banner_url ? (
                        <div
                          class="discover-card-banner"
                          style={`background-image: url("${cssUrl(s.banner_url)}")`}
                          aria-hidden="true"
                        />
                      ) : null}
                      <header class="discover-card-head">
                        {s.icon_url ? (
                          <img class="discover-card-icon" src={s.icon_url} alt="" />
                        ) : (
                          <span class="discover-card-mono" aria-hidden="true">
                            {(s.name || s.hostname).slice(0, 2).toUpperCase()}
                          </span>
                        )}
                        <div class="discover-card-titles">
                          <h3>
                            {s.name}
                            <span
                              class={`discover-status discover-status-${s.health_status}`}
                              title={`Health: ${s.health_status}`}
                            />
                          </h3>
                          <span class="discover-card-host">
                            {s.hostname}:{s.port}
                            {s.tls ? ' (TLS)' : ''}
                          </span>
                        </div>
                      </header>
                      {s.description ? (
                        <p class="discover-card-desc">{s.description}</p>
                      ) : null}
                      <div class="discover-card-tags">
                        {s.verification_status === 'verified' ? (
                          <Badge tone="info">VERIFIED</Badge>
                        ) : null}
                        {s.is_nsfw ? <Badge tone="warn">NSFW</Badge> : null}
                        {s.tags.slice(0, 4).map((t) => (
                          <span key={t} class="discover-tag">
                            {t.toUpperCase()}
                          </span>
                        ))}
                      </div>
                      <footer class="discover-card-foot">
                        <a class="btn btn-primary btn-sm" href={joinUrl(s)}>
                          Open in Boson
                        </a>
                        {typeof s.user_count === 'number' ? (
                          <span class="discover-card-meta">{s.user_count} online</span>
                        ) : null}
                      </footer>
                    </article>
                  </Card>
                </li>
              ))}
            </ul>
            {next && (
              <div class="discover-more">
                {moreError && <p class="discover-more-error">Couldn't load more servers. {moreError}</p>}
                <button type="button" class="btn btn-secondary" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : moreError ? 'Try again' : 'Load more servers'}
                </button>
              </div>
            )}
            </>
          )}
        </div>
      </section>

      <section class="section cta-strip discover-cta">
        <div class="container">
          <h2 style="margin-bottom: 16px;">Don't have Boson yet?</h2>
          <p class="lead">
            The "Open in Boson" buttons need the desktop client installed — it registers the{' '}
            <span class="num">boson://</span> URL scheme with your OS at install time. Grab it
            below and any directory link on this page works as a one-click connect.
          </p>
          <div class="hero-cta" style="justify-content: center;">
            <a class="btn btn-primary" href="/download">
              Download Boson v{release.version}
            </a>
            <a class="btn btn-secondary" href="/docs#add-manual">
              Add a server manually
            </a>
            <a class="btn btn-secondary" href={DIRECTORY_URL}>
              List your server
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
