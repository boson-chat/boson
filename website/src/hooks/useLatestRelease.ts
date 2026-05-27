import { useEffect, useState } from 'preact/hooks';
import pkg from '../../package.json';

/**
 * The website deploys to Cloudflare on every push to main, in parallel
 * with the semantic-release workflow that bumps `package.json`. That
 * means a build-time version (e.g. `import pkg from '../package.json'`)
 * is always one release behind: when v0.1.0 is being cut, the website
 * deploy has already published with v0.0.3 baked in.
 *
 * Fetching the latest tag from the GitHub Releases API at runtime
 * sidesteps the whole coordination problem — the page always reflects
 * the newest release the moment it goes live, no workflow chaining
 * needed. We cache the result in sessionStorage so route navigation
 * doesn't keep hitting the API, and we fall back to the build-time
 * version if the fetch fails (offline preview, network blocked, API
 * rate limit, etc.).
 */
export interface LatestRelease {
  version: string;        // "0.1.0" — no leading v
  releaseDate: string;    // "2026-05-27" — ISO date, no time
  url: string;            // https URL to the release page on GitHub
  source: 'github' | 'package';
}

const REPO = 'boson-chat/boson';
const CACHE_KEY = 'boson-latest-release';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — releases land less often

interface CachedEntry {
  fetchedAt: number;
  payload: LatestRelease;
}

function buildFallback(): LatestRelease {
  return {
    version: pkg.version,
    releaseDate: '',
    url: `https://github.com/${REPO}/releases/latest`,
    source: 'package',
  };
}

function readCache(): LatestRelease | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CachedEntry;
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
    return entry.payload;
  } catch {
    return null;
  }
}

function writeCache(payload: LatestRelease): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    const entry: CachedEntry = { fetchedAt: Date.now(), payload };
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // sessionStorage can throw in private-browsing or quota-exceeded —
    // not worth surfacing, the fetch path still works without cache.
  }
}

export function useLatestRelease(): LatestRelease {
  const [release, setRelease] = useState<LatestRelease>(() => readCache() ?? buildFallback());

  useEffect(() => {
    let cancelled = false;
    const cached = readCache();
    if (cached) {
      setRelease(cached);
      return;
    }
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data || typeof data.tag_name !== 'string') return;
        // Strip the leading v from "v0.1.0" — every release tag uses
        // that prefix and the page already prepends `v` where it
        // wants one (e.g. the eyebrow text).
        const version = data.tag_name.replace(/^v/i, '');
        const publishedAt = typeof data.published_at === 'string' ? data.published_at : '';
        const payload: LatestRelease = {
          version,
          releaseDate: publishedAt ? publishedAt.slice(0, 10) : '',
          url: typeof data.html_url === 'string' ? data.html_url : `https://github.com/${REPO}/releases/tag/${data.tag_name}`,
          source: 'github',
        };
        setRelease(payload);
        writeCache(payload);
      })
      .catch(() => {
        // Silent failure — the fallback from initial state stays in
        // place. We don't surface a network error to the visitor;
        // showing the cached build-time version is the right call.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return release;
}
