import { useEffect, useMemo, useState } from 'preact/hooks';
import { AtomLoader, Badge, Card } from '@boson/shared';
import { useLatestRelease } from '../hooks/useLatestRelease';
import './DiscoverPage.css';

// Live mirror of `backend/internal/services/server/model.go`. We only
// pick out the fields the public list endpoint actually returns + the
// renderer-side cards use; extra fields the backend evolves into are
// silently ignored by the destructuring below.
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
}

// In dev, vite.config.ts proxies `/servers` → VITE_BOSON_API_URL (defaults to
// https://api.boson.chat) so the browser never has to cross origins. In prod
// the website at https://boson.chat hits api.boson.chat directly — that
// cross-origin call needs `https://boson.chat` on the backend's
// ALLOWED_ORIGINS list. The const is a function of mode rather than a plain
// string so the production bundle ships the absolute URL while dev uses the
// proxy path.
const API_BASE = import.meta.env.DEV ? '' : (import.meta.env.VITE_BOSON_API_URL ?? 'https://api.boson.chat');

/**
 * Build the `boson://` deep-link the desktop app handles. The Electron
 * main process registers the scheme; clicking the link from a normal
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

export function DiscoverPage() {
  const [servers, setServers] = useState<Server[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [language, setLanguage] = useState<'all' | string>('all');
  const [showNsfw, setShowNsfw] = useState(false);
  const release = useLatestRelease();

  useEffect(() => {
    let cancelled = false;
    setServers(null);
    setError(null);
    fetch(`${API_BASE}/servers`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data?.servers) ? (data.servers as Server[]) : [];
        setServers(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load directory');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Derive the language filter options from whatever the backend
  // currently advertises — avoids us hard-coding "English / Español /
  // 日本語" and falling behind when new languages get added.
  const languages = useMemo(() => {
    if (!servers) return [];
    const seen = new Set<string>();
    for (const s of servers) for (const lang of s.languages) seen.add(lang);
    return Array.from(seen).sort();
  }, [servers]);

  const filtered = useMemo(() => {
    if (!servers) return null;
    const q = query.trim().toLowerCase();
    return servers.filter((s) => {
      if (!showNsfw && s.is_nsfw) return false;
      if (language !== 'all' && !s.languages.includes(language)) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.hostname.toLowerCase().includes(q) ||
        (s.description ?? '').toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [servers, query, language, showNsfw]);

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
                  {lang}
                </button>
              ))}
            </div>
            <label class="discover-nsfw">
              <input
                type="checkbox"
                checked={showNsfw}
                onChange={(e) => setShowNsfw((e.target as HTMLInputElement).checked)}
              />
              <span>Show NSFW</span>
            </label>
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
            servers && servers.length === 0 ? (
              <div class="discover-state">
                <p>The directory is empty.</p>
                <p class="muted" style="max-width: 50ch;">
                  No servers have been listed yet — the registration flow
                  for self-hosters is on the way (see{' '}
                  <a href="/docs#host-start" class="docs-link">List in the directory</a>).
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
            <ul class="discover-grid">
              {filtered.map((s) => (
                <li key={s.id}>
                  <Card variant="raised">
                    <article class="discover-card">
                      <header class="discover-card-head">
                        <span class="discover-card-mono" aria-hidden="true">
                          {(s.name || s.hostname).slice(0, 2).toUpperCase()}
                        </span>
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
          </div>
        </div>
      </section>
    </>
  );
}
